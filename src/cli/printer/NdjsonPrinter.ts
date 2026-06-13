import type { AgentEvent } from '@shared/ipc'
import type { Printer } from './Printer'

/** One AgentEvent per line on stdout. Stable, machine-parseable, streaming. */
export class NdjsonPrinter implements Printer {
  handle(event: AgentEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
}
