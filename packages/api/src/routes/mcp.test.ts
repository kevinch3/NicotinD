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

function seedSong(
  id: string,
  title: string,
  path = `p/${id}.opus`,
  albumId = 'al',
  opts?: { landedAt?: number | null; genre?: string | null },
) {
  const landedAt = opts?.landedAt === undefined ? 1 : opts.landedAt;
  const genre = opts?.genre ?? null;
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at, landed_at, genre)
     VALUES (?, ?, ?, 'Artist', 'art', 0, ?, 1, '2024', 1, ?, ?)`,
    [id, albumId, title, path, landedAt, genre],
  );
}

const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-mcp-test-'));
afterAll(() => rmSync(musicDir, { recursive: true, force: true }));

beforeEach(() => {
  testDb.run('DELETE FROM agent_tokens');
  testDb.run('DELETE FROM library_songs');
  testDb.run('DELETE FROM library_albums');
  testDb.run('DELETE FROM library_artists');
  testDb.run('DELETE FROM audit_log');
  testDb.run('DELETE FROM library_artist_aliases');
  testDb.run('DELETE FROM library_song_genres');
  testDb.run('DELETE FROM library_genre_overrides');
  testDb.run('DELETE FROM curation_flags');
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

  // issue #706 — `search_library` is the only discovery tool on the agent
  // surface, so accent-blind matching made an agent conclude a canonical artist
  // did not exist and mint a duplicate instead of merging into it.
  describe('search_library matches accent-insensitively', () => {
    const seedArtist = (id: string, name: string) =>
      testDb.run(
        `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 1, 1)`,
        [id, name],
      );
    const searchArtists = async (query: string): Promise<string[]> => {
      const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
      const body = (await (
        await rpc(token, 'tools/call', { name: 'search_library', arguments: { query } })
      ).json()) as { result: { content: Array<{ text: string }> } };
      const parsed = JSON.parse(body.result.content[0]!.text) as {
        artists: Array<{ name: string }>;
      };
      return parsed.artists.map((a) => a.name);
    };

    it('finds an accented artist from an unaccented query', async () => {
      seedArtist('a1', 'Américo');
      expect(await searchArtists('Americo')).toEqual(['Américo']);
    });

    it('finds an accented artist typed in upper case', async () => {
      // `COLLATE NOCASE` case-folds ASCII only, so "É" never equalled "é" —
      // even the correctly-spelled query missed.
      seedArtist('a1', 'Américo');
      expect(await searchArtists('AMÉRICO')).toEqual(['Américo']);
    });

    it('finds "Niño Bravo" from "Nino"', async () => {
      seedArtist('a1', 'Niño Bravo');
      expect(await searchArtists('Nino')).toEqual(['Niño Bravo']);
    });

    it('ANDs every token, so a multi-word query is not dropped to its first', async () => {
      seedArtist('a1', 'Héroes del Silencio');
      seedArtist('a2', 'Héroes de la Cumbia');
      expect(await searchArtists('heroes silencio')).toEqual(['Héroes del Silencio']);
    });

    it('matches songs and albums on the same folded rules', async () => {
      testDb.run(
        `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
         VALUES ('al1', 'Canción Animal', 'Soda Stereo', 'art', 1, 1)`,
      );
      seedSong('s1', 'Corazón Delator', 'p/s1.opus', 'al1');
      const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
      const body = (await (
        await rpc(token, 'tools/call', { name: 'search_library', arguments: { query: 'cancion' } })
      ).json()) as { result: { content: Array<{ text: string }> } };
      const parsed = JSON.parse(body.result.content[0]!.text) as {
        albums: Array<{ name: string }>;
      };
      expect(parsed.albums.map((a) => a.name)).toEqual(['Canción Animal']);
    });
  });

  it('tools/list includes list_recent_songs', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (await rpc(token, 'tools/list')).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toContain('list_recent_songs');
  });

  it('list_recent_songs orders newest-first by landed_at', async () => {
    seedSong('old', 'Old Song', undefined, undefined, { landedAt: 100 });
    seedSong('new', 'New Song', undefined, undefined, { landedAt: 200 });
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (
      await rpc(token, 'tools/call', { name: 'list_recent_songs', arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as { songs: Array<{ id: string }> };
    expect(parsed.songs.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('list_recent_songs excludes quarantined (landed_at IS NULL) songs', async () => {
    seedSong('landed', 'Landed', undefined, undefined, { landedAt: 100 });
    seedSong('quarantined', 'Quarantined', undefined, undefined, { landedAt: null });
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (
      await rpc(token, 'tools/call', { name: 'list_recent_songs', arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as { songs: Array<{ id: string }> };
    expect(parsed.songs.map((s) => s.id)).toEqual(['landed']);
  });

  it('list_recent_songs missingGenre filters to genre-less songs only', async () => {
    seedSong('has-genre', 'Has Genre', undefined, undefined, { landedAt: 100, genre: 'Techno' });
    seedSong('no-genre', 'No Genre', undefined, undefined, { landedAt: 200, genre: null });
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'list_recent_songs',
        arguments: { missingGenre: true },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as { songs: Array<{ id: string }> };
    expect(parsed.songs.map((s) => s.id)).toEqual(['no-genre']);
  });

  it('list_recent_songs pages with limit + offset, no overlap or gap', async () => {
    seedSong('s1', 'S1', undefined, undefined, { landedAt: 400 });
    seedSong('s2', 'S2', undefined, undefined, { landedAt: 300 });
    seedSong('s3', 'S3', undefined, undefined, { landedAt: 200 });
    seedSong('s4', 'S4', undefined, undefined, { landedAt: 100 });
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const page1 = (await (
      await rpc(token, 'tools/call', {
        name: 'list_recent_songs',
        arguments: { limit: 2, offset: 0 },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const page2 = (await (
      await rpc(token, 'tools/call', {
        name: 'list_recent_songs',
        arguments: { limit: 2, offset: 2 },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const ids1 = (
      JSON.parse(page1.result.content[0]!.text) as { songs: Array<{ id: string }> }
    ).songs.map((s) => s.id);
    const ids2 = (
      JSON.parse(page2.result.content[0]!.text) as { songs: Array<{ id: string }> }
    ).songs.map((s) => s.id);
    expect(ids1).toEqual(['s1', 's2']);
    expect(ids2).toEqual(['s3', 's4']);
  });

  it('tools/list includes set_song_genre', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a' });
    const body = (await (await rpc(token, 'tools/list')).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toContain('set_song_genre');
  });

  it('set_song_genre appends by default and audit-logs it (issue #677)', async () => {
    seedSong('s1', 'Song', undefined, undefined, { genre: 'Techno' });
    // `library_songs.genre` is only the primary mirror — the set itself lives in
    // library_song_genres, which is what append reads and rewrites.
    testDb.run(
      `INSERT INTO library_song_genres (song_id, genre, position) VALUES ('s1', 'Techno', 0)`,
    );
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'set_song_genre',
        arguments: { songId: 's1', genre: 'Minimal Techno' },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as { ok: boolean; genres: string[] };
    expect(parsed.ok).toBe(true);
    // Append keeps the existing genre first — it adds, it does not clobber.
    expect(parsed.genres).toEqual(['Techno', 'Minimal Techno']);

    const stored = testDb
      .query<{ genre: string }, [string]>(
        'SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position',
      )
      .all('s1');
    expect(stored.map((g) => g.genre)).toEqual(['Techno', 'Minimal Techno']);
    const audit = testDb.query('SELECT action, detail FROM audit_log').all() as Array<{
      action: string;
      detail: string;
    }>;
    const entry = audit.find((a) => a.action === 'song.genre');
    expect(entry?.detail).toContain('via MCP agent');
  });

  it("set_song_genre mode 'replace' writes a song-scoped override", async () => {
    seedSong('s1', 'Song', undefined, undefined, { genre: 'Techno' });
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    await rpc(token, 'tools/call', {
      name: 'set_song_genre',
      arguments: { songId: 's1', genre: 'Ambient;Drone', mode: 'replace' },
    });
    const override = testDb
      .query<{ genres: string }, [string]>(
        `SELECT genres FROM library_genre_overrides WHERE scope = 'song' AND key = ?`,
      )
      .get('s1');
    expect(override?.genres).toContain('Ambient');
    const primary = testDb
      .query<{ genre: string | null }, [string]>('SELECT genre FROM library_songs WHERE id = ?')
      .get('s1');
    expect(primary?.genre).toBe('Ambient');
  });

  it('set_song_genre reports an unknown song instead of writing', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'set_song_genre',
        arguments: { songId: 'nope', genre: 'Techno' },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('not found');
    expect(testDb.query('SELECT action FROM audit_log').all()).toHaveLength(0);
  });

  it('refuses set_song_genre for a read-only token', async () => {
    seedSong('s1', 'Song');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:read' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'set_song_genre',
        arguments: { songId: 's1', genre: 'Techno' },
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('read-only');
    expect(testDb.query('SELECT song_id FROM library_song_genres').all()).toHaveLength(0);
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

    const parsed = JSON.parse(body.result.content[0]!.text) as { kind: string; artistId: string };
    expect(parsed.kind).toBe('merged');
    expect(parsed.artistId).toBeTruthy();
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

  it('merge_artist merges a batch of rawNames into one target (issue #680)', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        arguments: {
          rawNames: ['Enrico Sangiuliano - Biomorph', 'Enrico Sangiuliano @ Awakenings'],
          mergeInto: 'Enrico Sangiuliano',
          confirm: true,
        },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      ok: boolean;
      merged: Array<{ rawName: string }>;
      failed: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.merged).toHaveLength(2);
    expect(parsed.failed).toHaveLength(0);

    const aliases = testDb
      .query<{ canonical_name: string }, []>(`SELECT canonical_name FROM library_artist_aliases`)
      .all();
    expect(aliases).toHaveLength(2);
    expect(aliases.every((a) => a.canonical_name === 'Enrico Sangiuliano')).toBe(true);
    // One audit row per merge, so the log stays greppable per artist.
    const audit = testDb
      .query<{ target_id: string }, []>(
        `SELECT target_id FROM audit_log WHERE action = 'artist.identity'`,
      )
      .all();
    expect(audit.map((a) => a.target_id).sort()).toEqual([
      'Enrico Sangiuliano - Biomorph',
      'Enrico Sangiuliano @ Awakenings',
    ]);
  });

  it('merge_artist reports per-name failures without aborting the batch', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        // The second name normalizes to the target itself — a no-op merge the
        // service rejects; the first must still land.
        arguments: {
          rawNames: ['Bad Spelling', 'Good Artist'],
          mergeInto: 'Good Artist',
          confirm: true,
        },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      ok: boolean;
      merged: Array<{ rawName: string }>;
      failed: Array<{ rawName: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.merged.map((m) => m.rawName)).toEqual(['Bad Spelling']);
    expect(parsed.failed.map((f) => f.rawName)).toEqual(['Good Artist']);
    expect(testDb.query('SELECT alias_norm FROM library_artist_aliases').all()).toHaveLength(1);
  });

  // issue #707 — a case/accent duplicate is the common real duplication, and it
  // routes to the rename path. A batch can therefore hold both kinds at once.
  it('merge_artist reports a case/accent duplicate as a rename, per name', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        arguments: {
          rawNames: ['Héroes Del Silencio', 'Heroes del Silencio (Rock)'],
          mergeInto: 'Héroes del Silencio',
          confirm: true,
        },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      ok: boolean;
      kind: string;
      merged: Array<{ rawName: string; kind: string }>;
      failed: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.failed).toHaveLength(0);
    expect(parsed.merged).toEqual([
      { rawName: 'Héroes Del Silencio', kind: 'renamed' },
      { rawName: 'Heroes del Silencio (Rock)', kind: 'merged' },
    ]);
    // The batch is not one kind any more, so the top-level field says so
    // rather than picking one and mislabelling the other.
    expect(parsed.kind).toBe('mixed');
  });

  it('merge_artist audit-logs a respelling as a rename, not a merge', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    await rpc(token, 'tools/call', {
      name: 'merge_artist',
      arguments: { rawName: 'BANDANA', mergeInto: 'Bandana', confirm: true },
    });
    const entry = testDb
      .query<{ detail: string }, []>(
        `SELECT detail FROM audit_log WHERE action = 'artist.identity'`,
      )
      .get();
    expect(entry?.detail).toContain('rename → Bandana');
  });

  it('merge_artist without rawName or rawNames is refused', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'merge_artist',
        arguments: { mergeInto: 'B', confirm: true },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('required');
    expect(testDb.query('SELECT alias_norm FROM library_artist_aliases').get()).toBeNull();
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

  it('flag_for_review records a flag and audit-logs it (issue #682)', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'flag_for_review',
        arguments: {
          targetKind: 'artist',
          targetId: 'Secret Cinema B2B Egbert',
          reason: 'b2b set — two acts, no single merge target',
        },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as { ok: boolean; created: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.created).toBe(true);

    const row = testDb
      .query<{ target_id: string; reason: string; created_by: string }, []>(
        'SELECT target_id, reason, created_by FROM curation_flags WHERE resolved_at IS NULL',
      )
      .get();
    expect(row?.target_id).toBe('Secret Cinema B2B Egbert');
    expect(row?.created_by).toStartWith('agent:');
    const audit = testDb.query('SELECT action FROM audit_log').all() as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('curation.flag');
  });

  it('flag_for_review is not destructive — it needs no confirm, and writes no library data', async () => {
    seedSong('s1', 'Song');
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    await rpc(token, 'tools/call', {
      name: 'flag_for_review',
      arguments: { targetKind: 'song', targetId: 's1', reason: 'wrong artist?' },
    });
    // Flagging is inert: the song row is untouched.
    const song = testDb
      .query<{ artist: string }, [string]>('SELECT artist FROM library_songs WHERE id = ?')
      .get('s1');
    expect(song?.artist).toBe('Artist');
  });

  it('flag_for_review rejects an unknown target kind', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:curate' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'flag_for_review',
        arguments: { targetKind: 'playlist', targetId: 'p1', reason: 'x' },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('targetKind');
    expect(testDb.query('SELECT id FROM curation_flags').all()).toHaveLength(0);
  });

  it('refuses flag_for_review for a read-only token', async () => {
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'a', scope: 'refiner:read' });
    const body = (await (
      await rpc(token, 'tools/call', {
        name: 'flag_for_review',
        arguments: { targetKind: 'artist', targetId: 'A', reason: 'x' },
      })
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('read-only');
    expect(testDb.query('SELECT id FROM curation_flags').all()).toHaveLength(0);
  });

  it('list_review_flags returns the open queue oldest-first, for a read-only token', async () => {
    const curate = mintAgentToken(testDb, { userId: 'u1', name: 'c', scope: 'refiner:curate' });
    await rpc(curate.token, 'tools/call', {
      name: 'flag_for_review',
      arguments: { targetKind: 'artist', targetId: 'A', reason: 'first' },
    });
    await rpc(curate.token, 'tools/call', {
      name: 'flag_for_review',
      arguments: { targetKind: 'artist', targetId: 'B', reason: 'second' },
    });
    const { token } = mintAgentToken(testDb, { userId: 'u1', name: 'r', scope: 'refiner:read' });
    const body = (await (
      await rpc(token, 'tools/call', { name: 'list_review_flags', arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      flags: Array<{ targetId: string }>;
    };
    expect(parsed.flags.map((f) => f.targetId)).toEqual(['A', 'B']);
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
    songGenre: { musicDir },
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
