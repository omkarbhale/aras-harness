import { ArasAuthError, ArasFaultError, ArasRequestError } from '@core/aras'

/** Stable exit codes so an LLM caller can branch on outcome without parsing stdout. */
export const ExitCode = {
  Ok: 0,
  Unexpected: 1,
  PendingApproval: 10,
  Denied: 20,
  Connection: 30,
  Llm: 40
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/** Map any thrown error to a CLI exit code + a one-line user-readable message. */
export function classifyError(error: unknown): { code: ExitCodeValue; message: string } {
  if (
    error instanceof ArasAuthError ||
    error instanceof ArasRequestError ||
    error instanceof ArasFaultError
  ) {
    return { code: ExitCode.Connection, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/api[_ -]?key|unauthorized|401|invalid api key/i.test(message)) {
    return { code: ExitCode.Llm, message }
  }
  return { code: ExitCode.Unexpected, message }
}

/** Print an error to stderr and exit with the classified code. */
export function fail(error: unknown): never {
  const { code, message } = classifyError(error)
  process.stderr.write(`error: ${message}\n`)
  process.exit(code)
}
