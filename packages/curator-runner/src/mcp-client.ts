/**
 * A minimal client for NicotinD's `/api/mcp` JSON-RPC endpoint — the same
 * surface an interactive agent uses, so the runner gets no capability the
 * server's token policy does not grant. → docs/mcp-agent.md
 */

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface ToolResult {
  ok: boolean;
  text: string;
}

/** What the run loop needs from MCP; a fake implements it in tests. */
export interface McpLike {
  initialize(): Promise<string>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export class McpError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;

export class McpClient implements McpLike {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) throw new McpError('MCP token rejected (invalid, revoked or expired)');
    if (!res.ok) throw new McpError(`MCP ${method} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new McpError(`MCP ${method} error: ${body.error.message ?? 'unknown'}`);
    return body.result;
  }

  /** Returns the server's `instructions`, which state the token's scope. */
  async initialize(): Promise<string> {
    const result = (await this.rpc('initialize')) as { instructions?: string } | undefined;
    return result?.instructions ?? '';
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { ok: result?.isError !== true, text: result?.content?.[0]?.text ?? '' };
  }
}

/**
 * Call a read tool and parse its JSON, throwing on a refusal or an `{error}`
 * body — a read the run depends on must never be mistaken for empty data.
 */
export async function readJson<T>(
  mcp: McpLike,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await mcp.call(name, args);
  if (!res.ok) throw new McpError(`${name} refused: ${res.text}`);
  const parsed = JSON.parse(res.text) as T & { error?: string };
  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    throw new McpError(`${name}: ${parsed.error}`);
  }
  return parsed;
}
