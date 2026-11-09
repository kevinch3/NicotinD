import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A fixture LRCLIB, so a spec can decide what the lyrics source answers
 * (docs/lyrics-options.md, "Testing seam"). The server reads NICOTIND_LRCLIB_URL
 * once at boot and fetches from inside its own process, so `page.route` cannot
 * reach those requests; before this, every spec depended on lrclib.net matching
 * nothing for the fixture titles.
 *
 * It answers the two endpoints `services/plugins/lrclib` calls, `/api/get` and
 * `/api/search`, from records a spec seeds. Unseeded, `/get` is a 404 and
 * `/search` an empty list: LRCLIB's own "no match", which is what the suite saw
 * from the real service.
 *
 * Specs run in parallel against one fixture, so records are keyed by artist and
 * title: seeding a song replaces only that song's records, and a spec seeds
 * titles no other spec uses. Shapes follow `LrclibTrack` in the plugin, not a
 * recording of LRCLIB, so this proves the wiring, not LRCLIB's behaviour.
 */
export const FIXTURE_LRCLIB_PORT = process.env.E2E_LRCLIB_PORT ?? '8590';
export const FIXTURE_LRCLIB_URL = `http://127.0.0.1:${FIXTURE_LRCLIB_PORT}`;

export interface FixtureLyricsRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  /**
   * The one record `/get` returns for this song. LRCLIB's `/get` answers a single
   * record, which may be untimed while `/search` holds a timed take (#1672).
   * Without one, `/get` 404s and the plugin goes to `/search`.
   */
  exact?: boolean;
}

const key = (artist: string, title: string) =>
  `${artist.trim().toLowerCase()}\u0000${title.trim().toLowerCase()}`;

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${FIXTURE_LRCLIB_URL}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fixture LRCLIB ${path} failed: ${res.status}`);
}

/** Replace the records of every song named in `records` (by artist and title). */
export const seedFixtureLyrics = (records: FixtureLyricsRecord[]): Promise<void> =>
  post('/__fixture/seed', { records });

/** Forget the named songs, so the fixture answers "no match" for them again. */
export const clearFixtureLyrics = (songs: { artist: string; title: string }[]): Promise<void> =>
  post('/__fixture/clear', { songs });

/** How many `/get` and `/search` requests reached the fixture for one song. */
export async function fixtureLyricsCalls(artist: string, title: string): Promise<number> {
  const q = new URLSearchParams({ artist, title });
  const res = await fetch(`${FIXTURE_LRCLIB_URL}/__fixture/calls?${q}`);
  return ((await res.json()) as { calls: number }).calls;
}

interface State {
  songs: Map<string, FixtureLyricsRecord[]>;
  calls: Map<string, number>;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function handle(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', FIXTURE_LRCLIB_URL);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/__fixture/health') return json({ ok: true });
  if (url.pathname === '/__fixture/seed' && req.method === 'POST') {
    const records = (await bodyOf(req)).records as FixtureLyricsRecord[];
    const bySong = new Map<string, FixtureLyricsRecord[]>();
    for (const r of records) {
      const k = key(r.artistName, r.trackName);
      bySong.set(k, [...(bySong.get(k) ?? []), r]);
    }
    for (const [k, rs] of bySong) state.songs.set(k, rs);
    return json({ ok: true });
  }
  if (url.pathname === '/__fixture/clear' && req.method === 'POST') {
    const songs = (await bodyOf(req)).songs as { artist: string; title: string }[];
    for (const s of songs) {
      state.songs.delete(key(s.artist, s.title));
      state.calls.delete(key(s.artist, s.title));
    }
    return json({ ok: true });
  }
  if (url.pathname === '/__fixture/calls') {
    const k = key(url.searchParams.get('artist') ?? '', url.searchParams.get('title') ?? '');
    return json({ calls: state.calls.get(k) ?? 0 });
  }

  const k = key(
    url.searchParams.get('artist_name') ?? '',
    url.searchParams.get('track_name') ?? '',
  );
  const records = state.songs.get(k) ?? [];
  if (url.pathname === '/api/get' || url.pathname === '/api/search') {
    state.calls.set(k, (state.calls.get(k) ?? 0) + 1);
  }
  if (url.pathname === '/api/get') {
    // LRCLIB's /get matches the duration within ±2 s when one is sent.
    const duration = Number(url.searchParams.get('duration'));
    const exact = records.find(
      (r) =>
        r.exact &&
        (!duration || typeof r.duration !== 'number' || Math.abs(r.duration - duration) <= 2),
    );
    return exact ? json(exact) : json({ message: 'Failed to find specified track' }, 404);
  }
  if (url.pathname === '/api/search') return json(records);
  return json({ message: `fixture LRCLIB has no ${req.method} ${url.pathname}` }, 404);
}

export function startFixtureLrclib(port = Number(FIXTURE_LRCLIB_PORT)) {
  const state: State = { songs: new Map(), calls: new Map() };
  const server = createServer((req, res) => {
    handle(state, req, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: String(err) }));
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// Launched by playwright.config.ts as a `webServer` of its own.
if (import.meta.main) startFixtureLrclib();
