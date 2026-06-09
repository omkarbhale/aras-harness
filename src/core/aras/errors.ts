/** Errors surfaced by the Aras layer. Kept distinct so callers (and the agent's
 *  tool wrappers) can react differently to auth vs request vs server-fault failures. */

export class ArasAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArasAuthError'
  }
}

export class ArasRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message)
    this.name = 'ArasRequestError'
  }
}

/** An AML-level fault returned in the SOAP body (e.g. permission denied, bad query). */
export class ArasFaultError extends Error {
  constructor(
    message: string,
    readonly faultCode?: string
  ) {
    super(message)
    this.name = 'ArasFaultError'
  }
}
