import { ArasClient, type ArasCredentials } from '../aras'

/**
 * Holds the single active Aras connection for the lifetime of the MCP server
 * process. stdio MCP runs one process per client, so one in-memory client is the
 * right model: `aras_connect` establishes it, every other tool reuses it. The
 * underlying {@link ArasClient} handles OAuth token caching and refresh.
 */
export class ConnectionManager {
  private client: ArasClient | undefined
  private activeName: string | undefined
  private creds: ArasCredentials | undefined

  /** Injectable factory so tests can supply a client over a mock HttpClient. */
  constructor(
    private readonly clientFactory: (creds: ArasCredentials) => ArasClient = (c) => new ArasClient(c)
  ) {}

  /**
   * Authenticate against an instance and make it the active connection.
   * Runs a trivial AML round-trip so bad credentials fail here, loudly, rather
   * than on the first real tool call.
   */
  async connect(creds: ArasCredentials, name?: string): Promise<{ latencyMs: number }> {
    const client = this.clientFactory(creds)
    const { latencyMs } = await client.testConnection()
    this.client = client
    this.creds = creds
    this.activeName = name ?? creds.instanceUrl
    return { latencyMs }
  }

  /**
   * The credentials of the active connection, for tools that must hand them to an
   * out-of-process driver (the .NET import/export utilities run as a PowerShell
   * subprocess and re-authenticate themselves; they can't share the in-memory token).
   * Throws the same "connect first" error as {@link getClient} when unset.
   */
  getCredentials(): ArasCredentials {
    if (!this.creds) {
      throw new Error('No active Aras connection. Call aras_connect (with a profile name or inline credentials) first.')
    }
    return this.creds
  }

  /** The active client, or a readable error telling the agent to connect first. */
  getClient(): ArasClient {
    if (!this.client) {
      throw new Error('No active Aras connection. Call aras_connect (with a profile name or inline credentials) first.')
    }
    return this.client
  }

  isConnected(): boolean {
    return this.client !== undefined
  }

  /** Name (or URL) of the active connection, if any. */
  get active(): string | undefined {
    return this.activeName
  }

  disconnect(): void {
    this.client = undefined
    this.creds = undefined
    this.activeName = undefined
  }
}
