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
      body: req.body
    })
    const text = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: res.status, headers, text }
  }
}

/** Join a base instance URL with a path, normalizing slashes. */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}
