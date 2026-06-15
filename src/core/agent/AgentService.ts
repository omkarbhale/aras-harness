import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { Command, interrupt as _interrupt } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { AgentEvent } from '@shared/ipc'
import type { ApprovalRequest } from './tools'

// Keep a value reference so tree-shaking doesn't drop the re-export used by tools.ts.
void _interrupt

const SYSTEM_PROMPT = `You are Aras Harness, an expert assistant for developers working with Aras Innovator (a PLM platform).
You accomplish the user's intent by reasoning and calling tools against a LIVE Aras instance.

## AML syntax essentials
AML is the XML dialect Aras uses. A request is a complete <AML>...</AML> document containing one or
more <Item> elements.
- On an <Item>, these are ATTRIBUTES (inside the opening tag): type (the ItemType name),
  action (get/add/edit/update/delete/lock/unlock/promote/...), id (the item's GUID), where, select,
  maxRecords, orderBy.
- Child elements set or match PROPERTY VALUES, e.g. <name>Bracket</name>, <item_number>P-1001</item_number>.
- CRITICAL: when you target a specific item by id — for edit, update, delete, lock, unlock, promote,
  or a direct get — the id MUST be the id ATTRIBUTE on the Item tag, NEVER a child element.
    Correct:  <Item type="Part" action="edit" id="ABC123"><name>1</name></Item>
    WRONG:    <Item type="Part" action="edit"><id>ABC123</id><name>1</name></Item>
  The wrong form does not select the row; the write fails or hits the wrong data.
- action="edit" modifies an existing item and needs the id (or a where clause); action="add" creates
  a new one; action="get" reads.

## Never guess the data model — confirm it
- Do NOT invent or assume property names, ItemType names, relationship names, list values, or
  classifications. They vary per instance.
- Before writing AML against an ItemType you have not already confirmed this session, call
  introspect_itemtype (or list_itemtypes) and use the EXACT property names and data types it returns.
- For values constrained to a List / lifecycle state / classification, confirm the allowed values
  (query an existing item or the List) before setting them.

## Relationships
- In Aras a relationship is its own ItemType. A relationship row links two items:
  source_id = the parent, related_id = the linked ("related") item. The row can also carry its own
  properties (e.g. quantity, sort_order on a "Part BOM").
- DISCOVER from schema — don't guess the relationship name. introspect_itemtype returns the
  RelationshipTypes whose source is that ItemType (relationship name + related ItemType) alongside its
  properties. You can also query them directly:
      <AML><Item type="RelationshipType" action="get" select="name,related_id">
        <source_id><Item type="ItemType" action="get" select="id"><name>Part</name></Item></source_id>
      </Item></AML>
  Then introspect_itemtype on the relationship name itself to learn ITS properties before setting them.
- READ relationship data by nesting a get inside <Relationships>:
      <Item type="Part" action="get" id="ABC123" select="item_number">
        <Relationships><Item type="Part BOM" action="get" select="related_id,quantity" /></Relationships>
      </Item>
- ADD a relationship by nesting an add under the parent — source_id is set from the parent
  automatically; you supply related_id and any relationship properties:
      <Item type="Part" action="edit" id="PARENT_ID">
        <Relationships><Item type="Part BOM" action="add">
          <related_id>CHILD_PART_ID</related_id><quantity>2</quantity>
        </Item></Relationships>
      </Item>
- EDIT or DELETE a relationship row by its own id, as a normal edit/delete on the relationship
  ItemType (id as the attribute, per the rule above).

## Use existing data as a template
- Before creating or relating items, get one or two existing items of the same type (and their
  relationships) and mirror their structure: which properties are populated, item_number / naming
  format, how source_id / related_id are wired, classification and lifecycle values.
- Prefer matching the instance's established conventions over a generic guess.

## Writes and approval — do NOT ask in chat
- Every mutating action is gated by an automatic human-in-the-loop approval built into run_aml: the
  harness pauses and shows the user an approve/reject prompt with your exact AML.
- So do NOT ask "should I proceed?" / "may I run this?" in chat — it is redundant and stalls the run.
  Just CALL run_aml with the mutating AML; the approval prompt fires by itself.
- One short statement of intent before the call is fine ("I'll add a Part P-1001"). A question that
  waits for a chat reply is not. If the user rejects, the tool tells you — adjust and retry.

## General
- AML must be a complete <AML>...</AML> document. Always put a sensible maxRecords on get queries.
- After acting, summarize what you found or changed in plain language.`

export interface RunUntilPauseArgs {
  runId: string
  threadId: string
  /** A user message starts a turn; a Command({resume}) resumes a previously paused one. */
  input: HumanMessage | Command
  emit: (event: AgentEvent) => void
}

export type RunUntilPauseResult =
  | { status: 'done' }
  | { status: 'paused'; approvalId: string; request: ApprovalRequest }

type ApprovalSignal = { paused: { approvalId: string; request: ApprovalRequest } } | null

/**
 * Wraps a LangGraph ReAct agent (model + tools + checkpointer) and adapts its stream
 * into the flat {@link AgentEvent} sequence the UI / CLI consumes. Mutating tools
 * pause via `interrupt()`; one call to {@link runUntilPause} streams a single segment
 * (initial turn OR a resume) and returns when either the graph finishes or the next
 * approval is required. Callers loop on the return value, supplying decisions via
 * `Command({resume})`. This contract is checkpointer-agnostic — same loop works for
 * an in-process UI wrapper and for a fresh CLI process resuming a paused thread.
 */
export class AgentService {
  private readonly agent: ReturnType<typeof createReactAgent>
  private currentAC: AbortController | undefined

  constructor(
    model: BaseChatModel,
    tools: StructuredToolInterface[],
    checkpointer: BaseCheckpointSaver
  ) {
    this.agent = createReactAgent({
      llm: model,
      tools,
      checkpointSaver: checkpointer
    })
  }

  /** AbortSignal for the currently running segment (tools use this for retry / fetch abort). */
  getCurrentSignal(): AbortSignal | undefined {
    return this.currentAC?.signal
  }

  /** Abort the currently streaming segment. Safe to call when idle. */
  cancel(): void {
    this.currentAC?.abort()
  }

  /**
   * Stream one segment of the agent's execution. Returns `paused` if an approval
   * `interrupt()` fires, otherwise `done`. Throws on abort or unhandled error.
   */
  async runUntilPause(args: RunUntilPauseArgs): Promise<RunUntilPauseResult> {
    const { runId, threadId, input, emit } = args
    const ac = new AbortController()
    this.currentAC = ac
    const config = { configurable: { thread_id: threadId } }

    try {
      // Initial turn: the system prompt only goes in if this thread has no prior history.
      // Resume turns (input is a Command) skip this — LangGraph picks up from the checkpoint.
      let streamInput: unknown
      if (input instanceof Command) {
        streamInput = input
      } else {
        const state = await this.agent.getState(config)
        const existing = (state?.values as { messages?: unknown[] } | undefined)?.messages
        const hasHistory = Array.isArray(existing) && existing.length > 0
        streamInput = hasHistory
          ? { messages: [input] }
          : { messages: [new SystemMessage(SYSTEM_PROMPT), input] }
      }

      const pause = await this.streamSegment(runId, streamInput, config, ac.signal, emit)
      if (pause) {
        return { status: 'paused', approvalId: pause.paused.approvalId, request: pause.paused.request }
      }
      return { status: 'done' }
    } finally {
      if (this.currentAC === ac) this.currentAC = undefined
    }
  }

  private async streamSegment(
    runId: string,
    input: unknown,
    config: { configurable: { thread_id: string } },
    signal: AbortSignal,
    emit: (event: AgentEvent) => void
  ): Promise<ApprovalSignal> {
    const stream = await this.agent.stream(
      input as Parameters<(typeof this.agent)['stream']>[0],
      { ...config, signal, streamMode: ['updates', 'messages'] }
    )

    let paused: ApprovalSignal = null
    for await (const chunk of stream) {
      const [mode, payload] = chunk as [string, unknown]
      if (mode === 'messages') {
        this.emitTokens(runId, payload, emit)
      } else if (mode === 'updates') {
        const interrupted = this.handleUpdates(runId, payload, emit)
        if (interrupted) paused = interrupted
      }
    }
    return paused
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
  ): ApprovalSignal {
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
        return { paused: { approvalId: value.approvalId, request: value } }
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
