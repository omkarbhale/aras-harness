import { createHash } from 'node:crypto'
import type { AmlResult } from './types'
import { FetchHttpClient, joinUrl, type HttpClient } from './http'
import { ArasAuthError, ArasRequestError } from './errors'
import { parseAmlResponse } from './amlParser'

export interface ArasCredentials {
  /** Base instance URL, e.g. http://localhost/InnovatorServer */
  instanceUrl: string
  database: string
  username: string
  password: string
}

export interface ArasClientOptions {
  http?: HttpClient
  /** Injectable clock for token-expiry tests. */
  now?: () => number
  /** OAuth client id registered in OAuth.config; "IOMApp" is the Aras default. */
  clientId?: string
}

interface CachedToken {
  accessToken: string
  /** Epoch ms after which the token must be refreshed (with safety margin). */
  expiresAt: number
}

/**
 * Talks to a live Aras Innovator instance over OAuth + REST/OData.
 *
 * Auth flow (Aras 12 / 2024 / 29):
 *   1. GET {instance}/Server/OAuthServerDiscovery.aspx -> { locations: [{ uri }] }
 *      (the OAuth server location, *not* the token endpoint directly).
 *   2. GET {oauthServer}/.well-known/openid-configuration -> token_endpoint.
 *   3. POST token_endpoint (grant_type=password, client_id=IOMApp, db/user/pass) -> access_token
 *   4. Use `Authorization: Bearer <token>` for AML (Server/InnovatorServer.aspx) and OData calls.
 *
 * This is the *only* class that knows Aras wire details; everything else (tools,
 * agent, UI) goes through its small surface.
 */
export class ArasClient {
  private readonly http: HttpClient
  private readonly now: () => number
  private readonly clientId: string
  private token: CachedToken | undefined

  constructor(
    private readonly creds: ArasCredentials,
    options: ArasClientOptions = {}
  ) {
    this.http = options.http ?? new FetchHttpClient()
    this.now = options.now ?? Date.now
    this.clientId = options.clientId ?? 'IOMApp'
  }

  /**
   * Discover the OAuth token endpoint advertised by the instance.
   *
   * Aras splits this across two hops: `OAuthServerDiscovery.aspx` returns the OAuth
   * server *location*, then that server's standard OpenID configuration carries the
   * actual `token_endpoint`. Some builds put `token_endpoint` directly on the first
   * response, so we honor that shortcut when present.
   */
  private async discoverTokenEndpoint(): Promise<string> {
    const discoveryUrl = joinUrl(this.creds.instanceUrl, '/Server/OAuthServerDiscovery.aspx')
    const discovery = await this.getJson(discoveryUrl, 'OAuth discovery')

    // Shortcut: a few builds advertise the token endpoint on the first response.
    if (typeof discovery.token_endpoint === 'string') return discovery.token_endpoint

    const oauthServer = discovery.locations?.[0]?.uri
    if (!oauthServer) {
      throw new ArasAuthError('OAuth discovery response missing OAuth server location')
    }

    const configUrl = joinUrl(oauthServer, '/.well-known/openid-configuration')
    const config = await this.getJson(configUrl, 'OpenID configuration')
    if (!config.token_endpoint) {
      throw new ArasAuthError('OpenID configuration missing token_endpoint')
    }
    return config.token_endpoint
  }

  /** GET a URL expecting a JSON body, with uniform HTTP/parse error handling. */
  private async getJson(
    url: string,
    what: string
  ): Promise<{ token_endpoint?: string; locations?: Array<{ uri?: string }> }> {
    const res = await this.http.send({ method: 'GET', url, headers: { Accept: 'application/json' } })
    if (res.status !== 200) {
      throw new ArasAuthError(`${what} failed (HTTP ${res.status}) at ${url}`)
    }
    try {
      return JSON.parse(res.text)
    } catch {
      throw new ArasAuthError(`${what} returned non-JSON response`)
    }
  }

  /** Request a fresh access token via the password grant. */
  private async fetchToken(): Promise<CachedToken> {
    const tokenEndpoint = await this.discoverTokenEndpoint()
    // Aras's OAuth server validates the password against its stored MD5 hash, so the
    // password grant expects the MD5 hex digest — not the plaintext. (Sending plaintext
    // yields HTTP 400 "incompatible_hash_use_md5".) This mirrors what the Aras login
    // client does before it ever leaves the browser.
    const passwordHash = createHash('md5').update(this.creds.password).digest('hex')
    const form = new URLSearchParams({
      grant_type: 'password',
      scope: 'Innovator',
      client_id: this.clientId,
      username: this.creds.username,
      password: passwordHash,
      database: this.creds.database
    })
    const res = await this.http.send({
      method: 'POST',
      url: tokenEndpoint,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: form.toString()
    })
    if (res.status !== 200) {
      throw new ArasAuthError(`Token request failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
    }
    let json: { access_token?: string; expires_in?: number | string }
    try {
      json = JSON.parse(res.text)
    } catch {
      throw new ArasAuthError('Token endpoint returned non-JSON response')
    }
    if (!json.access_token) {
      throw new ArasAuthError('Token response missing access_token')
    }
    const expiresInSec = Number(json.expires_in ?? 3600)
    // Refresh 60s early to avoid using a token that expires mid-request.
    const expiresAt = this.now() + Math.max(expiresInSec - 60, 30) * 1000
    return { accessToken: json.access_token, expiresAt }
  }

  private async getToken(): Promise<string> {
    if (!this.token || this.now() >= this.token.expiresAt) {
      this.token = await this.fetchToken()
    }
    return this.token.accessToken
  }

  /** Force re-authentication on the next call (e.g. after a 401). */
  invalidateToken(): void {
    this.token = undefined
  }

  /**
   * Execute a raw AML body. The body is wrapped in a SOAP envelope and POSTed to the
   * Innovator AML gateway. Returns parsed items, or throws on fault/HTTP error.
   */
  async runAml(amlBody: string, signal?: AbortSignal): Promise<AmlResult> {
    const token = await this.getToken()
    const url = joinUrl(this.creds.instanceUrl, '/Server/InnovatorServer.aspx')
    const envelope =
      '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<SOAP-ENV:Body>' +
      amlBody +
      '</SOAP-ENV:Body>' +
      '</SOAP-ENV:Envelope>'
    const res = await this.http.send({
      method: 'POST',
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        SOAPAction: 'ApplyItem',
        'Content-Type': 'text/xml; charset=utf-8',
        DATABASE: this.creds.database
      },
      body: envelope,
      signal
    })
    if (res.status === 401) {
      this.invalidateToken()
      throw new ArasAuthError('AML request unauthorized (401) — token rejected')
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ArasRequestError(`AML request failed (HTTP ${res.status})`, res.status, res.text)
    }
    return parseAmlResponse(res.text)
  }

  /**
   * Run an OData GET query. `path` is appended to `/server/odata` — e.g.
   * `Part?$top=10&$filter=...`. Returns the parsed JSON payload.
   */
  async runODataQuery(path: string, signal?: AbortSignal): Promise<unknown> {
    const token = await this.getToken()
    const cleaned = path.replace(/^\/+/, '')
    const url = joinUrl(this.creds.instanceUrl, `/server/odata/${cleaned}`)
    const res = await this.http.send({
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal
    })
    if (res.status === 401) {
      this.invalidateToken()
      throw new ArasAuthError('OData request unauthorized (401) — token rejected')
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ArasRequestError(`OData request failed (HTTP ${res.status})`, res.status, res.text)
    }
    try {
      return JSON.parse(res.text)
    } catch {
      throw new ArasRequestError('OData response was not valid JSON', res.status, res.text)
    }
  }

  /** Lightweight connectivity check: authenticate and run a trivial AML query. */
  async testConnection(): Promise<{ latencyMs: number }> {
    const start = this.now()
    // `max_records="1"` keeps the round-trip cheap; ItemType always exists in a valid DB.
    await this.runAml(
      '<AML><Item type="ItemType" action="get" select="id" maxRecords="1" /></AML>'
    )
    return { latencyMs: this.now() - start }
  }
}
