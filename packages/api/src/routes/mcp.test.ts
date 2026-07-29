import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { mintAgentToken } from '../services/agent-tokens.js';
import { dispatchTool, checkToolAccess, type McpToolContext } from './mcp.js';

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'u', 'h', 'refiner')",
);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const { mcpRoutes } = await import('./mcp.js');

function seedSong(id: string, title: string) {
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at, landed_at)
     VALUES (?, 'al', ?, 'Artist', 'art', 0, ?, 1, '2024', 1, 1)`,
    [id, title, `p/${id}.opus`],
  );
}

beforeEach(() => {
  testDb.run('DELETE FROM agent_tokens');
  testDb.run('DELETE FROM library_songs');
  testDb.run('DELETE FROM audit_log');
});

async function rpc(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return mcpRoutes().request('http://x/', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('MCP endpoint (issue #232)', () => {
  it('401s without a valid agent token', async () => {
    expect((await rpc(null, 'tools/list')).status).toBe(401);
    expect((await rpc('nca_bogus', 'tools/list')).status).toBe(401);
  });

  it('initialize reports server info + the refiner cap', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const res = await rpc(token, 'initialize');
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; instructions: string };
    };
    expect(body.result.serverInfo.name).toBe('nicotind-mcp');
    expect(body.result.instructions).toContain('refiner');
  });

  it('tools/list returns the registered tools with input schemas', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (await rpc(token, 'tools/list')).json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('search_library');
    expect(names).toContain('set_song_licence');
    expect(body.result.tools[0]!.inputSchema).toBeDefined();
  });

  it('tools/call runs a read tool', async () => {
    seedSong('s1', 'Hello World');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (
      await rpc(token, 'tools/call', { name: 'search_library', arguments: { query: 'Hello' } })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('s1');
  });

  it('a curate tool sets the licence and audit-logs it', async () => {
    seedSong('s1', 'Song');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'set_song_licence',
        arguments: { songId: 's1', licence: 'cc-by' },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('cc-by');

    const row = testDb
      .query<{ licence: string | null }, [string]>('SELECT licence FROM library_songs WHERE id = ?')
      .get('s1');
    expect(row?.licence).toBe('cc-by');
    const audit = testDb.query('SELECT action FROM audit_log').all() as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('song.licence');
  });

  it('refuses a curate tool for a read-only token', async () => {
    seedSong('s1', 'Song');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:read' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'set_song_licence',
        arguments: { songId: 's1', licence: 'cc-by' },
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('read-only');
    // …and nothing was written.
    const row = testDb
      .query<{ licence: string | null }, [string]>('SELECT licence FROM library_songs WHERE id = ?')
      .get('s1');
    expect(row?.licence).toBeNull();
  });

  it('unknown method → JSON-RPC -32601', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (await rpc(token, 'nonsense/method')).json()) as {
      error: { code: number };
    };
    expect(body.error.code).toBe(-32601);
  });
});

describe('dispatchTool guards', () => {
  const ctx = (scope: 'refiner:read' | 'refiner:curate'): McpToolContext => ({
    db: testDb,
    identity: { tokenId: 't', userId: 'u1', scope },
  });

  it('an unknown tool returns an error result, not a throw', async () => {
    const res = await dispatchTool(ctx('refiner:curate'), 'does_not_exist', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Unknown tool');
  });
});

describe('checkToolAccess (scope + confirm gates)', () => {
  const readTool = { name: 'r', access: 'read' as const };
  const curateTool = { name: 'c', access: 'curate' as const };
  const destructiveTool = { name: 'd', access: 'curate' as const, destructive: true };

  it('a read tool is allowed for any scope', () => {
    expect(checkToolAccess(readTool, 'refiner:read', {})).toBeNull();
    expect(checkToolAccess(readTool, 'refiner:curate', {})).toBeNull();
  });

  it('a curate tool needs the :curate scope', () => {
    expect(checkToolAccess(curateTool, 'refiner:read', {})).toContain('read-only');
    expect(checkToolAccess(curateTool, 'refiner:curate', {})).toBeNull();
  });

  it('a destructive tool needs confirm:true even with the :curate scope', () => {
    expect(checkToolAccess(destructiveTool, 'refiner:curate', {})).toContain('confirm');
    expect(checkToolAccess(destructiveTool, 'refiner:curate', { confirm: false })).toContain(
      'confirm',
    );
    expect(checkToolAccess(destructiveTool, 'refiner:curate', { confirm: true })).toBeNull();
    // …and scope still comes first: a read-only token can't reach a destructive
    // tool even with confirm.
    expect(checkToolAccess(destructiveTool, 'refiner:read', { confirm: true })).toContain(
      'read-only',
    );
  });
});
