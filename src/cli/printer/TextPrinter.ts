import type { AgentEvent } from '@shared/ipc'
import type { Printer } from './Printer'

/**
 * Human-readable streaming output. Tokens stream as a continuous assistant
 * paragraph on stdout; meta lines (tool calls, approval requests, errors)
 * go to stderr so a pipe consumer can still capture just the content.
 */
export class TextPrinter implements Printer {
  private tokenOpen = false

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'user_message':
        this.closeToken()
        process.stderr.write(`\n→ you: ${event.content}\n`)
        break
      case 'token':
        if (!this.tokenOpen) {
          process.stdout.write('\n← agent: ')
          this.tokenOpen = true
        }
        process.stdout.write(event.delta)
        break
      case 'assistant_message':
        // The streamed tokens already covered the content; close the paragraph.
        this.closeToken()
        break
      case 'tool_start':
        this.closeToken()
        process.stderr.write(`  → ${event.name}(${truncate(JSON.stringify(event.args), 120)})\n`)
        break
      case 'tool_end':
        process.stderr.write(
          `  ← ${event.isError ? 'ERR ' : ''}${truncate(event.result, 200)}\n`
        )
        break
      case 'approval_request':
        this.closeToken()
        process.stderr.write(
          `\n⚠ Approval needed (${event.tool}): ${event.summary}\n` +
            `  approvalId: ${event.approvalId}\n` +
            `  payload:    ${truncate(JSON.stringify(event.payload), 400)}\n`
        )
        break
      case 'error':
        this.closeToken()
        process.stderr.write(`\n✗ ${event.message}\n`)
        break
      case 'run_start':
      case 'done':
      default:
        break
    }
  }

  finish(): void {
    this.closeToken()
  }

  private closeToken(): void {
    if (this.tokenOpen) {
      process.stdout.write('\n')
      this.tokenOpen = false
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
