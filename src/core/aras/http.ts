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

/**
 * Retry `fn` indefinitely with exponential backoff (2 s, 4 s, 8 s, …) on any thrown
 * error. Pass `signal` to abort mid-sleep so the caller's cancellation propagates.
 */
export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let delayMs = 2000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (err) {
      if (signal?.aborted) throw err
      await sleep(delayMs, signal)
      delayMs *= 2
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
