import type { ApprovalDecision } from '@core/agent'

/**
 * In-process rendezvous between the renderer's approval click and the main-process
 * agent loop. The CLI does not use this — it persists the paused-run state to sqlite
 * and exits, then a fresh `aras agent resume` invocation passes the decision directly
 * into a new {@link AgentService.runUntilPause} call.
 */
export class InProcessApprovalBus {
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>()

  awaitDecision(approvalId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      this.pending.set(approvalId, resolve)
      signal.addEventListener(
        'abort',
        () => {
          this.pending.delete(approvalId)
          reject(new Error('Cancelled'))
        },
        { once: true }
      )
    })
  }

  /** Resolves the matching awaitDecision promise. No-op if none pending (e.g. stale click). */
  provide(approvalId: string, decision: ApprovalDecision): void {
    const resolve = this.pending.get(approvalId)
    if (resolve) {
      this.pending.delete(approvalId)
      resolve(decision)
    }
  }
}
