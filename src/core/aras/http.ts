/**
 * Minimal HTTP abstraction so the ArasClient can be unit-tested without a live
 * server. The default implementation uses the global `fetch` (available in Node 18+
 * and the Electron main process).
 */

export interface HttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export interface HttpClient {
  send(req: HttpRequest): Promise<HttpResponse>
}

export class FetchHttpClient implements HttpClient {
  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal
    })
    const text = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: res.status, headers, text }
  }
}

export interface RetryOptions {
  /** Cap on attempts. Omitted/0 = infinite retries (default; matches original behaviour). */
  maxAttempts?: number
  /** First backoff before retry. Defaults to 2 s. */
  baseDelayMs?: number
  /** Maximum backoff per attempt. Defaults to 16 s. */
  maxDelayMs?: number
}

/**
 * Retry `fn` with exponential backoff + jitter on any thrown error.
 * Default behaviour is infinite retries cancellable via `signal` — pass
 * `{ maxAttempts: N }` to cap the number of attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  options: RetryOptions = {}
): Promise<T> {
  const max = options.maxAttempts && options.maxAttempts > 0 ? options.maxAttempts : Infinity
  const base = options.baseDelayMs ?? 2000
  const cap = options.maxDelayMs ?? 16000
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (signal?.aborted) throw err
      if (attempt >= max) throw err
      const exp = Math.min(cap, base * Math.pow(2, attempt - 1))
      const jitter = exp * (0.5 + Math.random() * 0.5) // 50%–100% of exp
      await sleep(jitter, signal)
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(id); reject(new Error('Cancelled')) }, { once: true })
    }
  })
}

/** Join a base instance URL with a path, normalizing slashes. */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}
