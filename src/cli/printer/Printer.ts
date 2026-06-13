import type { AgentEvent } from '@shared/ipc'

/**
 * Emits AgentEvents to stdout/stderr. Same interface for human-friendly text
 * and machine-friendly NDJSON; the agent command picks one based on `--json`.
 */
export interface Printer {
  handle(event: AgentEvent): void
  /** Optional terminal flush (e.g. a trailing newline) before the process exits. */
  finish?(): void
}
