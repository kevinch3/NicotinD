import type { APIRequestContext } from '@playwright/test';
import { test, expect, ADMIN, FIXTURE, bearer } from '../helpers';
import {
  clearFixtureLyrics,
  fixtureLyricsCalls,
  seedFixtureLyrics,
} from './helpers/fixture-lrclib';

/**
 * The lyrics source end to end: the real server, the real LRCLIB plugin, and
 * the fixture LRCLIB (`tests/helpers/fixture-lrclib.ts`) standing in for
 * lrclib.net. Before the fixture, no spec could say what the source answered, so
 * the plugin's rules were pinned by unit tests alone.
 *
 * It uses the single, which no other spec gives lyrics, and puts both the stored
 * row and the fixture back afterwards.
 */
const SONG = { artist: FIXTURE.single.artist, title: FIXTURE.single.title };
const LRC = '[00:00.50]first timed line\n[00:01.50]second timed line';

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

async function songOf(request: APIRequestContext, token: string) {
  const res = await request.get(`/api/library/songs?size=200&q=${encodeURIComponent(SONG.title)}`, {
    headers: bearer(token),
  });
  const songs = (await res.json()) as Array<{ id: string; title: string; duration: number }>;
  const song = songs.find((s) => s.title === SONG.title);
  expect(song, `the fixture single "${SONG.title}" is in the library`).toBeTruthy();
  return song!;
}

test.describe('lyrics source (fixture LRCLIB)', () => {
  let token: string;
  let song: { id: string; duration: number };

  test.beforeEach(async ({ request }) => {
    token = await adminToken(request);
    song = await songOf(request, token);
    await request.delete(`/api/library/songs/${song.id}/lyrics`, { headers: bearer(token) });
  });

  test.afterEach(async ({ request }) => {
    await request.delete(`/api/library/songs/${song.id}/lyrics`, { headers: bearer(token) });
    await clearFixtureLyrics([SONG]);
  });

  const fetchForced = (request: APIRequestContext) =>
    request.post(`/api/library/songs/${song.id}/lyrics/fetch`, {
      headers: bearer(token),
      data: { force: true },
    });

  test('an untimed /get record gives way to a timed /search take of the same length (#1672)', async ({
    request,
  }) => {
    const base = { trackName: SONG.title, artistName: SONG.artist, duration: song.duration };
    await seedFixtureLyrics([
      { ...base, id: 1, exact: true, plainLyrics: 'untimed words', syncedLyrics: null },
      { ...base, id: 2, plainLyrics: 'timed words', syncedLyrics: LRC },
    ]);

    const res = await fetchForced(request);

    expect(res.status()).toBe(200);
    const lyrics = (await res.json()) as { synced: string | null; source: string };
    expect(lyrics.synced).toBe(LRC);
    expect(lyrics.source).toBe('lrclib');
    expect(await fixtureLyricsCalls(SONG.artist, SONG.title)).toBeGreaterThan(0);
  });

  test('a source that turns untimed on the next fetch never costs the stored timing (#1672)', async ({
    request,
  }) => {
    const base = { trackName: SONG.title, artistName: SONG.artist, duration: song.duration };
    await seedFixtureLyrics([
      { ...base, id: 2, exact: true, plainLyrics: 'timed words', syncedLyrics: LRC },
    ]);
    expect((await (await fetchForced(request)).json()).synced).toBe(LRC);

    // The same song, answered untimed this time: LRCLIB's records change under us.
    await seedFixtureLyrics([
      { ...base, id: 1, exact: true, plainLyrics: 'untimed words', syncedLyrics: null },
    ]);
    await fetchForced(request);

    const stored = await request.get(`/api/library/songs/${song.id}/lyrics`, {
      headers: bearer(token),
    });
    expect(((await stored.json()) as { synced: string | null }).synced).toBe(LRC);
  });
});
