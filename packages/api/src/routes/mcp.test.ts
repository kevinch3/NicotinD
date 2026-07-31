import { describe, expect, it, beforeEach, afterAll, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { mintAgentToken } from '../services/agent-tokens.js';
import { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';
import { dispatchTool, checkToolAccess, type McpToolContext } from './mcp.js';

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'u', 'h', 'refiner')",
);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const { mcpRoutes } = await import('./mcp.js');

function seedSong(id: string, title: string, path = `p/${id}.opus`, albumId = 'al') {
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at, landed_at)
     VALUES (?, ?, ?, 'Artist', 'art', 0, ?, 1, '2024', 1, 1)`,
    [id, albumId, title, path],
  );
}

const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-mcp-test-'));
afterAll(() => rmSync(musicDir, { recursive: true, force: true }));

beforeEach(() => {
  testDb.run('DELETE FROM agent_tokens');
  testDb.run('DELETE FROM library_songs');
  testDb.run('DELETE FROM library_albums');
  testDb.run('DELETE FROM audit_log');
  testDb.run('DELETE FROM library_artist_aliases');
});

async function rpc(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return mcpRoutes(musicDir).request('http://x/', {
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
    expect(names).toContain('delete_song');
    expect(names).toContain('delete_album');
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

  it('deletes a song file + row when confirmed with a curate token, and audit-logs it', async () => {
    mkdirSync(join(musicDir, 'Artist', 'Album'), { recursive: true });
    const filePath = join(musicDir, 'Artist', 'Album', 's1.opus');
    writeFileSync(filePath, 'audio');
    seedSong('s1', 'Song', 'Artist/Album/s1.opus');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });

    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'delete_song',
        arguments: { songId: 's1', confirm: true },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };

    expect(body.result.content[0]!.text).toContain('"ok":true');
    expect(existsSync(filePath)).toBe(false);
    expect(testDb.query('SELECT id FROM library_songs WHERE id = ?').get('s1')).toBeNull();
    const audit = testDb.query('SELECT action FROM audit_log').all() as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('song.delete');
  });

  it('refuses delete_song without confirm:true, even with a curate token', async () => {
    seedSong('s1', 'Song');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', { name: 'delete_song', arguments: { songId: 's1' } })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('confirm');
    expect(testDb.query('SELECT id FROM library_songs WHERE id = ?').get('s1')).not.toBeNull();
  });

  it('refuses delete_album for a read-only token even with confirm:true', async () => {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES ('al1', 'Album', 'Artist', 'art', 1)`,
    );
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:read' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'delete_album',
        arguments: { albumId: 'al1', confirm: true },
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('read-only');
    expect(testDb.query('SELECT id FROM library_albums WHERE id = ?').get('al1')).not.toBeNull();
  });

  it('delete_album deletes every song on the album and audit-logs it', async () => {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES ('al2', 'Album Two', 'Artist', 'art', 1)`,
    );
    mkdirSync(join(musicDir, 'Artist', 'Album Two'), { recursive: true });
    writeFileSync(join(musicDir, 'Artist', 'Album Two', 't1.opus'), 'audio');
    writeFileSync(join(musicDir, 'Artist', 'Album Two', 't2.opus'), 'audio');
    seedSong('t1', 'Track 1', 'Artist/Album Two/t1.opus', 'al2');
    seedSong('t2', 'Track 2', 'Artist/Album Two/t2.opus', 'al2');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });

    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'delete_album',
        arguments: { albumId: 'al2', confirm: true },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };

    expect(body.result.content[0]!.text).toContain('"deletedCount":2');
    expect(testDb.query('SELECT id FROM library_albums WHERE id = ?').get('al2')).toBeNull();
    const audit = testDb.query('SELECT action FROM audit_log').all() as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('album.delete');
  });

  it('tools/list includes merge_artist', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (await rpc(token, 'tools/list')).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toContain('merge_artist');
  });

  it('merge_artist mints an alias, audit-logs it, and reports the target artist id', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });

    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        arguments: { rawName: 'Ke Personajes', mergeInto: 'Ke Personaje', confirm: true },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };

    expect(body.result.content[0]!.text).toContain('"kind":"merged"');
    const alias = testDb
      .query<{ canonical_name: string }, []>(`SELECT canonical_name FROM library_artist_aliases`)
      .get();
    expect(alias?.canonical_name).toBe('Ke Personaje');
    const audit = testDb.query('SELECT action, detail FROM audit_log').all() as Array<{
      action: string;
      detail: string;
    }>;
    const entry = audit.find((a) => a.action === 'artist.identity');
    expect(entry?.detail).toContain('merge → Ke Personaje');
  });

  it('refuses merge_artist without confirm:true, even with a curate token', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        arguments: { rawName: 'A', mergeInto: 'B' },
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('confirm');
    expect(testDb.query('SELECT alias_norm FROM library_artist_aliases').get()).toBeNull();
  });

  it('refuses merge_artist for a read-only token even with confirm:true', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:read' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        arguments: { rawName: 'A', mergeInto: 'B', confirm: true },
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('read-only');
    expect(testDb.query('SELECT alias_norm FROM library_artist_aliases').get()).toBeNull();
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
    deletion: { musicDir, shareRescan: new ShareRescanScheduler(async () => {}) },
    artistIdentity: { dataDir: undefined, runSync: undefined },
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
