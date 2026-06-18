import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { ArasClient, type ArasCredentials } from './ArasClient'
import type { HttpClient, HttpRequest, HttpResponse } from './http'
import { ArasAuthError, ArasFaultError } from './errors'

const creds: ArasCredentials = {
  instanceUrl: 'http://localhost/InnovatorServer',
  database: 'InnovatorSolutions',
  username: 'admin',
  password: 'secret'
}

// Aras's two-step discovery: the .aspx returns the OAuth server location, then that
// server's OpenID config carries the real token_endpoint.
const DISCOVERY = JSON.stringify({
  locations: [{ uri: 'http://localhost/InnovatorServer/OAuthServer/' }]
})

const OPENID_CONFIG = JSON.stringify({
  issuer: 'OAuthServer',
  token_endpoint: 'http://localhost/InnovatorServer/OAuthServer/connect/token'
})

const TOKEN = (token: string, expiresIn = 3600) =>
  JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' })

const AML_OK =
  '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<SOAP-ENV:Body><Result>' +
  '<Item type="Part" id="ABC123"><item_number>P-1</item_number><name>Widget</name></Item>' +
  '<Item type="Part" id="DEF456"><item_number>P-2</item_number><name>Gadget</name></Item>' +
  '</Result></SOAP-ENV:Body></SOAP-ENV:Envelope>'

const AML_FAULT =
  '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<SOAP-ENV:Body><SOAP-ENV:Fault>' +
  '<faultcode>0</faultcode><faultstring>No permission to access this item</faultstring>' +
  '</SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>'

// Aras reports an empty `get` as a fault (faultcode 0 + "No items of type X found").
const AML_NO_ITEMS =
  '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<SOAP-ENV:Body><SOAP-ENV:Fault>' +
  '<faultcode>0</faultcode><faultstring>No items of type Part found.</faultstring>' +
  '</SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>'

/** Programmable mock HTTP client that records requests and returns scripted responses. */
class MockHttp implements HttpClient {
  readonly requests: HttpRequest[] = []
  constructor(private readonly handler: (req: HttpRequest) => HttpResponse) {}
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req)
    return this.handler(req)
  }
}

function ok(text: string): HttpResponse {
  return { status: 200, headers: {}, text }
}

function route(req: HttpRequest): HttpResponse {
  if (req.url.includes('OAuthServerDiscovery')) return ok(DISCOVERY)
  if (req.url.includes('.well-known/openid-configuration')) return ok(OPENID_CONFIG)
  if (req.url.includes('connect/token')) return ok(TOKEN('tok-1'))
  if (req.url.includes('InnovatorServer.aspx')) return ok(AML_OK)
  throw new Error(`unexpected url ${req.url}`)
}

describe('ArasClient auth', () => {
  it('discovers the endpoint and requests a password-grant token once, then caches it', async () => {
    const http = new MockHttp(route)
    const client = new ArasClient(creds, { http })

    await client.runAml('<AML><Item type="Part" action="get" /></AML>')
    await client.runAml('<AML><Item type="Part" action="get" /></AML>')

    const discoveries = http.requests.filter((r) => r.url.includes('OAuthServerDiscovery'))
    const tokenReqs = http.requests.filter((r) => r.url.includes('connect/token'))
    expect(discoveries).toHaveLength(1)
    expect(tokenReqs).toHaveLength(1)

    const tokenBody = tokenReqs[0].body ?? ''
    expect(tokenBody).toContain('grant_type=password')
    expect(tokenBody).toContain('client_id=IOMApp')
    expect(tokenBody).toContain('database=InnovatorSolutions')
    // Password is sent as its MD5 hex digest, never as plaintext.
    const md5 = createHash('md5').update(creds.password).digest('hex')
    expect(tokenBody).toContain(`password=${md5}`)
    expect(tokenBody).not.toContain(`password=${creds.password}`)
  })

  it('re-fetches the token after expiry', async () => {
    let nowMs = 1_000_000
    const http = new MockHttp((req) =>
      req.url.includes('connect/token') ? ok(TOKEN('tok', 3600)) : route(req)
    )
    const client = new ArasClient(creds, { http, now: () => nowMs })

    await client.runAml('<AML/>')
    nowMs += 3_600_000 // advance past expiry
    await client.runAml('<AML/>')

    const tokenReqs = http.requests.filter((r) => r.url.includes('connect/token'))
    expect(tokenReqs).toHaveLength(2)
  })

  it('sends the bearer token on AML requests', async () => {
    const http = new MockHttp(route)
    const client = new ArasClient(creds, { http })
    await client.runAml('<AML/>')
    const amlReq = http.requests.find((r) => r.url.includes('InnovatorServer.aspx'))
    expect(amlReq?.headers?.Authorization).toBe('Bearer tok-1')
    expect(amlReq?.headers?.SOAPAction).toBe('ApplyAML')
  })

  it('throws ArasAuthError when the token endpoint rejects credentials', async () => {
    const http = new MockHttp((req) => {
      if (req.url.includes('OAuthServerDiscovery')) return ok(DISCOVERY)
      if (req.url.includes('.well-known/openid-configuration')) return ok(OPENID_CONFIG)
      if (req.url.includes('connect/token'))
        return { status: 400, headers: {}, text: '{"error":"invalid_grant"}' }
      return ok(AML_OK)
    })
    const client = new ArasClient(creds, { http })
    await expect(client.runAml('<AML/>')).rejects.toBeInstanceOf(ArasAuthError)
  })
})

describe('ArasClient AML results', () => {
  it('parses items from a successful response', async () => {
    const http = new MockHttp(route)
    const client = new ArasClient(creds, { http })
    const result = await client.runAml('<AML><Item type="Part" action="get" /></AML>')
    expect(result.count).toBe(2)
    expect(result.items[0]).toMatchObject({
      id: 'ABC123',
      type: 'Part',
      properties: { item_number: 'P-1', name: 'Widget' }
    })
  })

  it('throws ArasFaultError on a SOAP fault', async () => {
    const http = new MockHttp((req) =>
      req.url.includes('InnovatorServer.aspx') ? ok(AML_FAULT) : route(req)
    )
    const client = new ArasClient(creds, { http })
    await expect(client.runAml('<AML/>')).rejects.toMatchObject({
      name: 'ArasFaultError',
      message: 'No permission to access this item'
    })
    await expect(client.runAml('<AML/>')).rejects.toBeInstanceOf(ArasFaultError)
  })

  it('normalizes the "No items found" fault to an empty result instead of throwing', async () => {
    const http = new MockHttp((req) =>
      req.url.includes('InnovatorServer.aspx') ? ok(AML_NO_ITEMS) : route(req)
    )
    const client = new ArasClient(creds, { http })
    const result = await client.runAml('<AML/>')
    expect(result).toMatchObject({ count: 0, items: [] })
  })

  it('invalidates the token and throws on a 401', async () => {
    const http = new MockHttp((req) =>
      req.url.includes('InnovatorServer.aspx')
        ? { status: 401, headers: {}, text: 'Unauthorized' }
        : route(req)
    )
    const client = new ArasClient(creds, { http })
    await expect(client.runAml('<AML/>')).rejects.toBeInstanceOf(ArasAuthError)
  })
})
