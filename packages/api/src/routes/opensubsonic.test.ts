import { describe, expect, it, beforeEach, afterAll, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';

// The /rest layer runs on top of the REAL /api routes — that is the design
// (docs/opensubsonic.md) — so this suite mounts them over one in-memory DB.
const db = new Database(':memory:');
applySchema(db);
mock.module('../db.js', () => ({ getDatabase: () => db, applySchema }));

const { authMiddleware } = await import('../middleware/auth.js');
const { libraryRoutes } = await import('./library.js');
const { playlistRoutes } = await import('./playlists.js');
const { historyRoutes } = await import('./history.js');
const { streamingRoutes } = await import('./streaming.js');
const { subsonicKeysRoutes } = await import('./subsonic-keys.js');
const { openSubsonicRoutes } = await import('./opensubsonic.js');
const { internalUpstream } = await import('../services/opensubsonic-upstream.js');
const { LibrarySearchProvider } = await import('../services/providers/library-provider.js');
const { mintSubsonicKey } = await import('../services/subsonic-keys.js');

const SECRET = 'test-secret-at-least-32-chars-long-xx';
const root = mkdtempSync(join(tmpdir(), 'opensubsonic-'));
const musicDir = join(root, 'music');
const dataDir = join(root, 'data');
mkdirSync(join(musicDir, 'Air', 'Moon Safari'), { recursive: true });
mkdirSync(dataDir, { recursive: true });
const AUDIO = Buffer.from('fLaC-not-really-audio-but-bytes-0123456789');
writeFileSync(join(musicDir, 'Air', 'Moon Safari', '01 La Femme.flac'), AUDIO);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const app = new Hono();
const auth = authMiddleware(SECRET);
for (const p of [
  '/api/library/*',
  '/api/playlists/*',
  '/api/history/*',
  '/api/stream/*',
  '/api/cover/*',
  '/api/subsonic-keys/*',
]) {
  app.use(p, auth);
}
app.route('/api/library', libraryRoutes(musicDir));
app.route('/api/playlists', playlistRoutes());
app.route('/api/history', historyRoutes());
app.route(
  '/api/subsonic-keys',
  subsonicKeysRoutes(() => db),
);
app.route('/api', streamingRoutes(musicDir, db, dataDir));
const search = new LibrarySearchProvider(db);
app.route(
  '/rest',
  openSubsonicRoutes({
    getDb: () => db,
    serverVersion: '9.9.9',
    upstream: internalUpstream((r) => app.fetch(r), SECRET),
    searchLibrary: async (q) => (await search.search(q)).results,
  }),
);

function seed() {
  for (const t of [
    'user_starred_items',
    'subsonic_api_keys',
    'playlist_songs',
    'playlists',
    'play_events',
    'library_songs',
    'library_albums',
    'library_artists',
    'users',
  ]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run(
    "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'ana', 'h', 'listener')",
  );
  db.run("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bo', 'h', 'user')");
  const now = Date.now();
  db.run(
    `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES
       ('ar1', 'Air', 2, ?), ('ar2', 'The Beatles', 0, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, year, genre, created, classification, synced_at) VALUES
       ('al1', 'Moon Safari', 'Air', 'ar1', 2, 400, 1998, 'Electronic', '2026-01-01T00:00:00.000Z', 'album', ?),
       ('al2', 'Kelly Watch', 'Air', 'ar1', 1, 200, 1998, 'Electronic', '2026-01-02T00:00:00.000Z', 'single', ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, track, disc, duration, year, genre, path, size, suffix, content_type, created, synced_at) VALUES
       ('s1', 'al1', 'La Femme d''Argent', 'Air', 'ar1', 1, 1, 200, 1998, 'Electronic', 'Air/Moon Safari/01 La Femme.flac', ${AUDIO.length}, 'flac', 'audio/flac', '2026-01-01T00:00:00.000Z', ?),
       ('s2', 'al1', 'Sexy Boy', 'Air', 'ar1', 2, 1, 200, 1998, 'Electronic', 'Air/Moon Safari/02 Sexy Boy.flac', 10, 'flac', 'audio/flac', '2026-01-01T00:00:00.000Z', ?),
       ('s3', 'al2', 'Kelly Watch the Stars', 'Air', 'ar1', 1, 1, 200, 1998, 'Electronic', 'Air/Kelly/01.flac', 10, 'flac', 'audio/flac', '2026-01-02T00:00:00.000Z', ?)`,
    [now, now, now],
  );
}

let key = '';
beforeEach(() => {
  seed();
  key = mintSubsonicKey(db, 'u1', 'test').key;
});

type R = Record<string, unknown>;

async function call(
  method: string,
  params: Record<string, string | string[]> = {},
  init?: RequestInit,
) {
  const q = new URLSearchParams({ apiKey: key, f: 'json', c: 'test', v: '1.16.1' });
  for (const [k, v] of Object.entries(params)) {
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  return app.request(`/rest/${method}?${q}`, init);
}

async function ok(method: string, params: Record<string, string | string[]> = {}): Promise<R> {
  const body = (await (await call(method, params)).json()) as { 'subsonic-response': R };
  const r = body['subsonic-response'];
  expect(r.status, JSON.stringify(r.error)).toBe('ok');
  return r;
}

async function fail(method: string, query: string): Promise<{ code: number; message: string }> {
  const res = await app.request(`/rest/${method}?f=json&${query}`);
  const r = ((await res.json()) as { 'subsonic-response': R })['subsonic-response'];
  expect(r.status).toBe('failed');
  return r.error as { code: number; message: string };
}

describe('OpenSubsonic auth', () => {
  it('answers ping with an API key, with or without the .view suffix', async () => {
    const r = await ok('ping');
    expect(r).toMatchObject({
      version: '1.16.1',
      type: 'nicotind',
      serverVersion: '9.9.9',
      openSubsonic: true,
    });
    const view = await (await app.request(`/rest/ping.view?apiKey=${key}&f=json`)).json();
    expect((view as { 'subsonic-response': R })['subsonic-response'].status).toBe('ok');
  });

  it('serves the extension list without auth', async () => {
    const r = (await (await app.request('/rest/getOpenSubsonicExtensions?f=json')).json()) as {
      'subsonic-response': { openSubsonicExtensions: Array<{ name: string }> };
    };
    expect(r['subsonic-response'].openSubsonicExtensions.map((e) => e.name)).toContain(
      'apiKeyAuthentication',
    );
  });

  it('returns the Subsonic error codes for each auth failure', async () => {
    expect((await fail('ping', '')).code).toBe(10);
    expect((await fail('ping', 'apiKey=nss_bad')).code).toBe(44);
    expect((await fail('ping', `apiKey=${key}&u=ana`)).code).toBe(43);
    expect((await fail('ping', 'u=ana&t=abc&s=def')).code).toBe(41);
    expect((await fail('ping', `u=bo&p=${key}`)).code).toBe(40);
  });

  it('accepts the key as a legacy password, plain or enc:-hex', async () => {
    expect(
      (
        (await (await app.request(`/rest/ping?f=json&u=ana&p=${key}`)).json()) as {
          'subsonic-response': R;
        }
      )['subsonic-response'].status,
    ).toBe('ok');
    const hex = `enc:${Buffer.from(key).toString('hex')}`;
    expect(
      (
        (await (await app.request(`/rest/ping?f=json&u=ANA&p=${hex}`)).json()) as {
          'subsonic-response': R;
        }
      )['subsonic-response'].status,
    ).toBe('ok');
  });

  it('accepts parameters as a form POST (formPost extension)', async () => {
    const res = await app.request('/rest/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `apiKey=${key}&f=json`,
    });
    expect(((await res.json()) as { 'subsonic-response': R })['subsonic-response'].status).toBe(
      'ok',
    );
  });

  it('answers XML by default and an unknown method as error 70, not a 404 page', async () => {
    const xml = await (await app.request(`/rest/ping?apiKey=${key}`)).text();
    expect(xml).toContain('<subsonic-response xmlns="http://subsonic.org/restapi" status="ok"');
    expect((await fail('noSuchMethod', `apiKey=${key}`)).code).toBe(70);
  });
});

describe('OpenSubsonic browsing', () => {
  it('indexes artists and lists an artist’s albums and singles together', async () => {
    const r = (await ok('getArtists')) as {
      artists: { index: Array<{ name: string; artist: R[] }> };
    };
    expect(r.artists.index.map((i) => i.name)).toEqual(['A', 'B']);
    const a = (await ok('getArtist', { id: 'ar1' })) as {
      artist: { name: string; albumCount: number; album: R[] };
    };
    expect(a.artist.name).toBe('Air');
    expect(a.artist.album.map((x) => x.id).sort()).toEqual(['al1', 'al2']);
  });

  it('returns an album with its songs in track order', async () => {
    const r = (await ok('getAlbum', { id: 'al1' })) as {
      album: { song: R[]; releaseTypes: string[] };
    };
    expect(r.album.song.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(r.album.releaseTypes).toEqual(['Album']);
  });

  it('maps an unknown id to error 70', async () => {
    const res = await call('getAlbum', { id: 'nope' });
    const r = ((await res.json()) as { 'subsonic-response': { error: { code: number } } })[
      'subsonic-response'
    ];
    expect(r.error.code).toBe(70);
  });

  it('lists every release type, ordered by artist, in getAlbumList2', async () => {
    const r = (await ok('getAlbumList2', { type: 'alphabeticalByArtist', size: '10' })) as {
      albumList2: { album: R[] };
    };
    expect(r.albumList2.album.map((a) => a.id).sort()).toEqual(['al1', 'al2']);
    // `type` is required.
    expect((await fail('getAlbumList2', `apiKey=${key}`)).code).toBe(10);
  });

  it('enumerates the whole library with an empty search3 query, paged', async () => {
    const page1 = (await ok('search3', { query: '', songCount: '2', songOffset: '0' })) as {
      searchResult3: { song: R[]; album: R[]; artist: R[] };
    };
    const page2 = (await ok('search3', { query: '""', songCount: '2', songOffset: '2' })) as {
      searchResult3: { song: R[] };
    };
    const ids = [...page1.searchResult3.song, ...page2.searchResult3.song].map((s) => s.id);
    expect(ids.sort()).toEqual(['s1', 's2', 's3']);
    expect(page1.searchResult3.artist.length).toBe(2);
    expect(page1.searchResult3.album.length).toBe(2);
  });

  it('searches the library by text', async () => {
    const r = (await ok('search3', { query: 'sexy' })) as { searchResult3: { song: R[] } };
    expect(r.searchResult3.song.map((s) => s.id)).toEqual(['s2']);
    expect(r.searchResult3.song[0]).toMatchObject({ suffix: 'flac', albumId: 'al1' });
    // Albums come back whole — `created` and `duration` are required by
    // schema-validating clients, and the search provider's rows lack both.
    const albums = (await ok('search3', { query: 'moon' })) as { searchResult3: { album: R[] } };
    expect(albums.searchResult3.album[0]).toMatchObject({
      id: 'al1',
      created: '2026-01-01T00:00:00.000Z',
      duration: 400,
    });
  });

  it('walks folders through getMusicDirectory', async () => {
    const artist = (await ok('getMusicDirectory', { id: 'ar1' })) as { directory: { child: R[] } };
    expect(artist.directory.child.every((c) => c.isDir === true)).toBe(true);
    const album = (await ok('getMusicDirectory', { id: 'al1' })) as { directory: { child: R[] } };
    expect(album.directory.child.map((c) => c.id)).toEqual(['s1', 's2']);
  });
});

describe('OpenSubsonic media', () => {
  it('streams the file, honouring Range', async () => {
    const full = await call('stream', { id: 's1' });
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer()).equals(AUDIO)).toBe(true);
    const part = await call('stream', { id: 's1' }, { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('fLaC');
  });

  it('reports a missing file as error 70', async () => {
    const res = await call('stream', { id: 'gone' });
    const r = ((await res.json()) as { 'subsonic-response': { error: { code: number } } })[
      'subsonic-response'
    ];
    expect(r.error.code).toBe(70);
  });
});

describe('OpenSubsonic user data', () => {
  it('stars a song as a like, and an album as a per-user star', async () => {
    await ok('star', { id: 's1', albumId: 'al1' });
    const liked = (await (
      await app.request('/api/playlists', {
        headers: { Authorization: `Bearer ${await jwt('u1')}` },
      })
    ).json()) as { playlists: Array<{ kind: string; songCount: number }> };
    expect(liked.playlists.find((p) => p.kind === 'liked')?.songCount).toBe(1);

    const r = (await ok('getStarred2')) as { starred2: { song: R[]; album: R[] } };
    expect(r.starred2.song.map((s) => s.id)).toEqual(['s1']);
    expect(r.starred2.album.map((a) => a.id)).toEqual(['al1']);
    expect(typeof r.starred2.song[0]?.starred).toBe('string');

    // Stars are the caller's own.
    const other = mintSubsonicKey(db, 'u2', 'bo').key;
    const theirs = (await (
      await app.request(`/rest/getStarred2?f=json&apiKey=${other}`)
    ).json()) as {
      'subsonic-response': { starred2: { song: R[]; album: R[] } };
    };
    expect(theirs['subsonic-response'].starred2.song).toEqual([]);
    expect(theirs['subsonic-response'].starred2.album).toEqual([]);

    await ok('unstar', { id: ['s1', 'al1'] });
    const after = (await ok('getStarred2')) as { starred2: { song: R[]; album: R[] } };
    expect(after.starred2.song).toEqual([]);
    expect(after.starred2.album).toEqual([]);
  });

  it('creates, edits and deletes a playlist', async () => {
    const created = (await ok('createPlaylist', { name: 'Mix', songId: ['s1', 's2'] })) as {
      playlist: { id: string; entry: R[]; owner: string };
    };
    expect(created.playlist.entry.map((e) => e.id)).toEqual(['s1', 's2']);
    expect(created.playlist.owner).toBe('ana');
    const id = created.playlist.id;

    await ok('updatePlaylist', {
      playlistId: id,
      name: 'Mix 2',
      songIndexToRemove: '0',
      songIdToAdd: 's3',
    });
    const got = (await ok('getPlaylist', { id })) as { playlist: { name: string; entry: R[] } };
    expect(got.playlist.name).toBe('Mix 2');
    expect(got.playlist.entry.map((e) => e.id).sort()).toEqual(['s2', 's3']);

    const list = (await ok('getPlaylists')) as { playlists: { playlist: R[] } };
    expect(list.playlists.playlist.map((p) => p.id)).toContain(id);

    await ok('deletePlaylist', { id });
    const gone = await call('getPlaylist', { id });
    expect(
      ((await gone.json()) as { 'subsonic-response': { error: { code: number } } })[
        'subsonic-response'
      ].error.code,
    ).toBe(70);
  });

  it('records a scrobble once, however often the client retries it', async () => {
    await ok('scrobble', { id: 's1', time: '1700000000000' });
    await ok('scrobble', { id: 's1', time: '1700000000000' });
    await ok('scrobble', { id: 's2', submission: 'false' });
    const rows = db.query<{ song_id: string }, []>('SELECT song_id FROM play_events').all();
    expect(rows.map((r) => r.song_id)).toEqual(['s1']);
  });
});

describe('API key management', () => {
  it('mints, lists and revokes the caller’s own keys over /api', async () => {
    const headers = {
      Authorization: `Bearer ${await jwt('u2')}`,
      'Content-Type': 'application/json',
    };
    const res = await app.request('/api/subsonic-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'MA' }),
    });
    expect(res.status).toBe(201);
    const { id, key: raw } = (await res.json()) as { id: string; key: string };
    expect(raw.startsWith('nss_')).toBe(true);
    const list = (await (await app.request('/api/subsonic-keys', { headers })).json()) as {
      keys: Array<{ id: string }>;
    };
    expect(list.keys.map((k) => k.id)).toEqual([id]);
    expect(
      (await app.request('/api/subsonic-keys', { method: 'POST', headers, body: '{}' })).status,
    ).toBe(400);
    expect(
      (await app.request(`/api/subsonic-keys/${id}`, { method: 'DELETE', headers })).status,
    ).toBe(200);
    expect((await fail('ping', `apiKey=${raw}`)).code).toBe(44);
  });
});

async function jwt(sub: string): Promise<string> {
  const { signJwt } = await import('../middleware/auth.js');
  return signJwt({ sub, role: 'listener' }, SECRET);
}
