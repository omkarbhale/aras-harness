import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { Command, MemorySaver, interrupt as _interrupt } from '@langchain/langgraph'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { AgentEvent } from '@shared/ipc'
import type { ApprovalDecision, ApprovalRequest } from './tools'

// Keep a value reference so tree-shaking doesn't drop the re-export used by tools.ts.
void _interrupt

const SYSTEM_PROMPT = `You are Aras Harness, an expert assistant for developers working with Aras Innovator (a PLM platform).
You accomplish the user's intent by reasoning and calling tools against a LIVE Aras instance.

Guidelines:
- For unfamiliar ItemTypes, call list_itemtypes / introspect_itemtype to learn the schema BEFORE writing AML.
- Always include a sensible maxRecords limit on get queries.
- AML must be a complete <AML>...</AML> document.
- Mutating AML (add/update/delete/edit/create) requires user approval; the run_aml tool handles this — explain clearly what a write will do before issuing it.
- After acting, summarize what you found or changed in plain language.`

/** What a single streamed turn ended with. */
type TurnEnd = { interruptedApprovalId: string } | null

/**
 * Wraps a LangGraph ReAct agent (model + tools + checkpointer) and adapts its stream
 * into the flat {@link AgentEvent} sequence the UI consumes. Mutating tools pause via
 * `interrupt()`; this service surfaces the approval request and resumes on the user's
 * decision.
 */
export class AgentService {
  private readonly agent: ReturnType<typeof createReactAgent>
  private readonly checkpointer = new MemorySaver()
  private readonly threadId = `thread-${globalThis.crypto.randomUUID()}`
  private readonly pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>()
  private started = false
  private currentAC: AbortController | undefined

  constructor(model: BaseChatModel, tools: StructuredToolInterface[]) {
    this.agent = createReactAgent({
      llm: model,
      tools,
      checkpointSaver: this.checkpointer
    })
  }

  /** AbortSignal for the currently running turn (tools use this for retry / fetch abort). */
  getCurrentSignal(): AbortSignal | undefined {
    return this.currentAC?.signal
  }

  /** Abort the current run. Safe to call when idle. */
  cancel(): void {
    this.currentAC?.abort()
  }

  /** Run one user message to completion (handling any approval pauses), emitting events. */
  async run(runId: string, message: string, emit: (event: AgentEvent) => void): Promise<void> {
    const ac = new AbortController()
    this.currentAC = ac

    emit({ type: 'run_start', runId })
    const config = { configurable: { thread_id: this.threadId } }

    const firstInput = this.started
      ? { messages: [new HumanMessage(message)] }
      : { messages: [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(message)] }
    this.started = true

    try {
      let next: unknown = firstInput
      // Stream; each time the graph interrupts for approval, wait then resume.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const end = await this.streamTurn(runId, next, config, ac.signal, emit)
        if (!end) break
        const decision = await this.awaitApproval(end.interruptedApprovalId, ac.signal)
        next = new Command({ resume: decision })
      }
      emit({ type: 'done', runId })
    } catch (error) {
      if (ac.signal.aborted) {
        emit({ type: 'done', runId })
      } else {
        emit({ type: 'error', runId, message: toMessage(error) })
      }
    } finally {
      if (this.currentAC === ac) this.currentAC = undefined
    }
  }

  /** Resolve a pending approval so the paused run can resume. */
  provideApproval(approvalId: string, approved: boolean): void {
    const resolve = this.pendingApprovals.get(approvalId)
    if (resolve) {
      this.pendingApprovals.delete(approvalId)
      resolve({ approved })
    }
  }

  private awaitApproval(approvalId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(approvalId, resolve)
      signal.addEventListener('abort', () => {
        this.pendingApprovals.delete(approvalId)
        reject(new Error('Cancelled'))
      }, { once: true })
    })
  }

  private async streamTurn(
    runId: string,
    input: unknown,
    config: { configurable: { thread_id: string } },
    signal: AbortSignal,
    emit: (event: AgentEvent) => void
  ): Promise<TurnEnd> {
    const stream = await this.agent.stream(
      input as Parameters<(typeof this.agent)['stream']>[0],
      { ...config, signal, streamMode: ['updates', 'messages'] }
    )

    let end: TurnEnd = null
    for await (const chunk of stream) {
      const [mode, payload] = chunk as [string, unknown]
      if (mode === 'messages') {
        this.emitTokens(runId, payload, emit)
      } else if (mode === 'updates') {
        const interrupted = this.handleUpdates(runId, payload, emit)
        if (interrupted) end = interrupted
      }
    }
    return end
  }

  /** Extract streamed assistant text tokens from a `messages`-mode chunk. */
  private emitTokens(runId: string, payload: unknown, emit: (event: AgentEvent) => void): void {
    const messageChunk = Array.isArray(payload) ? payload[0] : payload
    const content = (messageChunk as { content?: unknown } | undefined)?.content
    const text = extractText(content)
    if (text) emit({ type: 'token', runId, delta: text })
  }

  /** Interpret an `updates`-mode chunk: tool starts/ends, final message, interrupts. */
  private handleUpdates(
    runId: string,
    payload: unknown,
    emit: (event: AgentEvent) => void
  ): TurnEnd {
    if (!payload || typeof payload !== 'object') return null
    const update = payload as Record<string, unknown>

    // Interrupt (approval request) surfaces under the __interrupt__ key.
    const interrupts = update['__interrupt__']
    if (Array.isArray(interrupts) && interrupts.length > 0) {
      const value = (interrupts[0] as { value?: unknown }).value as ApprovalRequest | undefined
      if (value && value.kind === 'approval') {
        emit({
          type: 'approval_request',
          runId,
          approvalId: value.approvalId,
          tool: value.tool,
          summary: value.summary,
          payload: value.payload
        })
        return { interruptedApprovalId: value.approvalId }
      }
    }

    for (const [node, nodeUpdate] of Object.entries(update)) {
      const messages = (nodeUpdate as { messages?: unknown } | undefined)?.messages
      if (!Array.isArray(messages)) continue
      for (const msg of messages) {
        this.emitFromMessage(runId, node, msg, emit)
      }
    }
    return null
  }

  private emitFromMessage(
    runId: string,
    node: string,
    msg: unknown,
    emit: (event: AgentEvent) => void
  ): void {
    const m = msg as {
      tool_calls?: { id?: string; name?: string; args?: unknown }[]
      content?: unknown
      tool_call_id?: string
      status?: string
      name?: string
    }

    // Agent node: tool calls requested, or a final assistant message.
    if (node !== 'tools' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const call of m.tool_calls) {
        emit({
          type: 'tool_start',
          runId,
          toolCallId: call.id ?? '',
          name: call.name ?? 'tool',
          args: call.args
        })
      }
      return
    }

    // Tools node: a ToolMessage with the result.
    if (node === 'tools' && m.tool_call_id) {
      emit({
        type: 'tool_end',
        runId,
        toolCallId: m.tool_call_id,
        result: extractText(m.content) ?? '',
        isError: m.status === 'error'
      })
      return
    }

    // Final assistant text (no tool calls).
    if (node !== 'tools') {
      const text = extractText(m.content)
      if (text) emit({ type: 'assistant_message', runId, content: text })
    }
  }
}

/** Flatten LangChain message content (string or content-block array) into plain text. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string'
          ? block
          : block && typeof block === 'object' && (block as { type?: string }).type === 'text'
            ? String((block as { text?: unknown }).text ?? '')
            : ''
      )
      .join('')
  }
  return ''
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
