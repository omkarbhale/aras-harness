import { randomUUID } from 'node:crypto'
import { Command as CommanderCommand } from 'commander'
import { HumanMessage } from '@langchain/core/messages'
import { Command as LangGraphCommand } from '@langchain/langgraph'
import type { AgentEvent } from '@shared/ipc'
import type { AppServices } from '@core/services'
import type { Printer } from '../printer/Printer'
import { NdjsonPrinter } from '../printer/NdjsonPrinter'
import { TextPrinter } from '../printer/TextPrinter'
import { ExitCode, classifyError } from '../exit'

const DEFAULT_THREAD_NAME = 'CLI chat'

/**
 * `aras agent ...` — send a message, resume after approval, or cancel a run.
 *
 * Lifecycle is process-scoped: one `send` runs until done or until LangGraph
 * pauses on a write-approval `interrupt()`. On pause the run state is
 * persisted (status='paused' + approvalId + approvalPayload on the runs row)
 * and the process exits with code 10. A later `aras agent resume <runId>` in
 * a fresh process loads the runs row and continues from the checkpointer.
 */
export function agentCommand(services: AppServices): CommanderCommand {
  const cmd = new CommanderCommand('agent').description('Send messages to the agent and manage runs')

  cmd
    .command('send <message>')
    .description('Send a message to the agent on a thread')
    .option('--thread <id>', 'Thread to send on (default: create a new one)')
    .option('--json', 'NDJSON output (one AgentEvent per line) instead of human text')
    .action(async (message: string, opts: { thread?: string; json?: boolean }) => {
      const threadId = ensureThread(services, opts.thread)
      const runId = randomUUID()
      const printer = opts.json ? new NdjsonPrinter() : new TextPrinter()
      process.stderr.write(`runId: ${runId}\nthread: ${threadId}\n`)
      const code = await driveCliRun({
        services,
        runId,
        threadId,
        input: new HumanMessage(message),
        printer,
        startMessage: message
      })
      process.exit(code)
    })

  cmd
    .command('resume <runId>')
    .description('Resume a paused run with an approval decision')
    .requiredOption('--decision <allow|deny>', 'allow or deny')
    .option('--json', 'NDJSON output (one AgentEvent per line) instead of human text')
    .action(async (runId: string, opts: { decision: string; json?: boolean }) => {
      const decision = opts.decision.toLowerCase()
      if (decision !== 'allow' && decision !== 'deny') {
        process.stderr.write(`error: --decision must be "allow" or "deny"\n`)
        process.exit(ExitCode.Unexpected)
      }
      const run = services.runStore.get(runId)
      if (!run) {
        process.stderr.write(`error: no run ${runId}\n`)
        process.exit(ExitCode.Unexpected)
      }
      if (run.status !== 'paused') {
        process.stderr.write(`error: run ${runId} is not paused (status=${run.status})\n`)
        process.exit(ExitCode.Unexpected)
      }
      const printer = opts.json ? new NdjsonPrinter() : new TextPrinter()
      process.stderr.write(`runId: ${runId}\nthread: ${run.threadId}\n`)
      const code = await driveCliRun({
        services,
        runId,
        threadId: run.threadId,
        input: new LangGraphCommand({ resume: { approved: decision === 'allow' } }),
        printer,
        // For denied resumes the agent re-enters runAml, sees not-approved, and
        // emits a "did NOT approve" tool result — caller still sees the stream.
        startMessage: null,
        approvedDecision: decision === 'allow'
      })
      process.exit(code)
    })

  cmd
    .command('cancel <runId>')
    .description('Cancel a running run (sets cancelRequested + SIGINTs the owning process)')
    .action((runId: string) => {
      const run = services.runStore.get(runId)
      if (!run) {
        process.stderr.write(`error: no run ${runId}\n`)
        process.exit(ExitCode.Unexpected)
      }
      services.runStore.requestCancel(runId)
      if (run.pid !== null) {
        try {
          process.kill(run.pid, 'SIGINT')
        } catch {
          // Process already exited or in a different session — `cancelRequested`
          // poll will pick it up next time the run streams an event.
        }
      }
      process.stdout.write('cancel requested\n')
    })

  return cmd
}

/** Resolve the thread to send on: --thread, or create a fresh one. */
function ensureThread(services: AppServices, explicit?: string): string {
  if (explicit) {
    if (!services.threadStore.get(explicit)) {
      services.threadStore.create({ id: explicit, name: DEFAULT_THREAD_NAME })
    }
    return explicit
  }
  const id = randomUUID()
  services.threadStore.create({ id, name: DEFAULT_THREAD_NAME })
  process.stderr.write(`created thread: ${id}\n`)
  return id
}

interface DriveCliRunInput {
  services: AppServices
  runId: string
  threadId: string
  input: HumanMessage | LangGraphCommand
  printer: Printer
  /** First user message — emit a user_message event on the initial send. */
  startMessage: string | null
  /** For a resume, the decision the user supplied (used to mark denied exits). */
  approvedDecision?: boolean
}

/**
 * Streams one CLI agent invocation to completion or to the next approval pause.
 * Returns the appropriate exit code. Persists every event + run state so a
 * separate process can resume or inspect.
 */
async function driveCliRun(args: DriveCliRunInput): Promise<number> {
  const { services, runId, threadId, input, printer, startMessage, approvedDecision } = args

  const isInitial = startMessage !== null
  const existing = services.runStore.get(runId)
  if (isInitial && !existing) {
    services.runStore.start({ runId, threadId, pid: process.pid })
  } else if (existing) {
    services.runStore.markStatus(runId, 'running')
  }

  const ac = new AbortController()
  const sigintHandler = (): void => {
    ac.abort()
  }
  process.on('SIGINT', sigintHandler)

  // Background poll for cross-process cancel: if `aras agent cancel <runId>`
  // wrote cancelRequested=1, abort this stream even when SIGINT couldn't reach us.
  const poll = setInterval(() => {
    if (services.runStore.isCancelRequested(runId)) ac.abort()
  }, 500).unref()

  const emit = (event: AgentEvent): void => {
    services.eventLog.append(threadId, runId, event)
    printer.handle(event)
  }

  emit({ type: 'run_start', runId })
  if (isInitial) {
    // Auto-name a freshly created thread from its first user message.
    const thread = services.threadStore.get(threadId)
    if (thread && thread.name === DEFAULT_THREAD_NAME) {
      const title = startMessage.trim().split(/\s+/).join(' ').slice(0, 60)
      if (title) services.threadStore.rename(threadId, title)
    }
    emit({ type: 'user_message', runId, content: startMessage })
  }

  try {
    const agent = await services.getOrCreateAgent()
    let next: HumanMessage | LangGraphCommand = input
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await agent.runUntilPause({ runId, threadId, input: next, emit })
      if (result.status === 'done') {
        services.runStore.markStatus(runId, 'done')
        services.threadStore.touch(threadId)
        emit({ type: 'done', runId })
        printer.finish?.()
        cleanup(sigintHandler, poll)
        // Denied resume completed cleanly — surface the user's choice in the exit code.
        return approvedDecision === false ? ExitCode.Denied : ExitCode.Ok
      }
      // Paused: persist + exit 10 for the caller (LLM or human) to inspect/decide.
      services.runStore.markPaused(runId, result.approvalId, result.request.payload)
      services.threadStore.touch(threadId)
      printer.finish?.()
      cleanup(sigintHandler, poll)
      return ExitCode.PendingApproval
    }
  } catch (error) {
    cleanup(sigintHandler, poll)
    if (ac.signal.aborted) {
      services.runStore.markStatus(runId, 'cancelled')
      emit({ type: 'done', runId })
      printer.finish?.()
      return ExitCode.Unexpected
    }
    services.runStore.markStatus(runId, 'error')
    const { code, message } = classifyError(error)
    emit({ type: 'error', runId, message })
    emit({ type: 'done', runId })
    printer.finish?.()
    return code
  }
}

function cleanup(handler: () => void, poll: NodeJS.Timeout): void {
  process.off('SIGINT', handler)
  clearInterval(poll)
}
