import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, bearer } from '../helpers';
import {
  startFixtureAddon,
  FIXTURE_ADDON_TOKEN,
  RICK_ASTLEY_PAYLOAD,
  type FixtureAddon,
} from './helpers/fixture-addon';

const ADDON_ID = 'fixture-hunt-addon';
const ADDON_AUTH = { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` };

/** The ingested release lands INSIDE the git-tracked fixtures/music tree — it
 *  must be removed on the way out or every later run inherits it. */
const LANDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/music/Rick Astley');

/**
 * The album-hunt → download path through a remote acquisition addon, themed on
 * the canonical rickroll (a silent FLAC tagged "Rick Astley — Whenever You Need
 * Somebody / Never Gonna Give You Up" — its tags are what land in the library).
 *
 * Covers two things the addon-acquire spec doesn't:
 * 1. `albums/search` — scored folder candidates, and the `rateLimited` flag
 *    (#hunt-429) that tells the host "keep trying" vs "no results".
 * 2. A hunt-shaped album job downloads + ingests to the library end-to-end, so
 *    "Rick Astley" appearing in the library is proof of the whole loop.
 *
 * (The browser hunt *modal* is Lidarr-gated and Lidarr isn't in the e2e env, so
 * the rateLimited UI toast/empty-state is covered by the modal unit spec; here
 * we prove the protocol surface + the download.)
 */
test.describe('hunt + download through a remote addon (rickroll)', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;
  let landedAlbumId = '';

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({ id: ADDON_ID, payload: RICK_ASTLEY_PAYLOAD });
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    auth = bearer(((await login.json()) as { token: string }).token);

    const registered = await request.post('/api/plugins/addons', {
      headers: auth,
      data: { url: addon.url, token: FIXTURE_ADDON_TOKEN },
    });
    expect(registered.status()).toBe(201);
    const enabled = await request.post(`/api/plugins/${ADDON_ID}/enable`, {
      headers: auth,
      data: { consent: true },
    });
    expect(enabled.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (landedAlbumId) {
      await request
        .delete(`/api/library/albums/${landedAlbumId}`, { headers: auth })
        .catch(() => {});
    }
    rmSync(LANDED_DIR, { recursive: true, force: true });
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  test('albums/search returns candidates, and flags rateLimited when throttled', async ({
    request,
  }) => {
    const body = {
      artist: 'Rick Astley',
      album: 'Whenever You Need Somebody',
      canonicalTracks: [{ title: 'Never Gonna Give You Up' }],
    };

    // A normal hunt: one 100% Rick Astley candidate.
    const ok = await request.post(`${addon.url}/addon/v1/albums/search`, {
      headers: ADDON_AUTH,
      data: body,
    });
    expect(ok.status()).toBe(200);
    const hit = (await ok.json()) as {
      candidates: Array<{ matchPct: number }>;
      rateLimited?: boolean;
    };
    expect(hit.candidates.length).toBe(1);
    expect(hit.candidates[0]!.matchPct).toBe(100);
    expect(hit.rateLimited ?? false).toBe(false);

    // Throttled: empty candidates + rateLimited=true → the UI keeps trying.
    addon.setRateLimited(true);
    const throttled = await request.post(`${addon.url}/addon/v1/albums/search`, {
      headers: ADDON_AUTH,
      data: body,
    });
    const rl = (await throttled.json()) as {
      candidates: unknown[];
      rateLimited?: boolean;
    };
    expect(rl.candidates.length).toBe(0);
    expect(rl.rateLimited).toBe(true);
    addon.setRateLimited(false);
  });

  test('downloads the Rick Astley album and it lands in the library', async ({ request }) => {
    // Enqueue an album job addon-side (the shape a hunt-download enqueue uses).
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: ADDON_AUTH,
      data: {
        intent: 'album',
        artist: 'Rick Astley',
        album: 'Whenever You Need Somebody',
        candidateRef: 'fixture-candidate-1',
      },
    });
    expect(created.status()).toBe(201);

    // The poller mirrors it into the unified feed.
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return false;
          const jobs = (await res.json()) as Array<{ albumTitle: string | null; method: string }>;
          return jobs.some(
            (j) => j.albumTitle === 'Whenever You Need Somebody' && j.method === ADDON_ID,
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // Finish addon-side; the poller fetches the file, organizes + scans it.
    addon.completeJobs();
    let albumId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return '';
          const jobs = (await res.json()) as Array<{
            albumTitle: string | null;
            stage: string;
            albumId: string | null;
          }>;
          const job = jobs.find((j) => j.albumTitle === 'Whenever You Need Somebody');
          if (job?.stage === 'done' && job.albumId) {
            albumId = job.albumId;
            landedAlbumId = job.albumId;
          }
          return job?.stage ?? '';
        },
        { timeout: 30_000 },
      )
      .toBe('done');

    // "Rick Astley" in the library is proof of hunt-shape → download → ingest.
    const detailRes = await request.get(`/api/library/albums/${albumId}`, { headers: auth });
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as {
      artist: string;
      song: Array<{ id: string; title: string }>;
    };
    expect(detail.artist).toBe('Rick Astley');
    expect(detail.song.some((s) => s.title === 'Never Gonna Give You Up')).toBe(true);

    // Provenance recorded under the addon id.
    const acq = await request.get(`/api/library/songs/${detail.song[0]!.id}/acquisition`, {
      headers: auth,
    });
    expect(acq.status()).toBe(200);
    expect(((await acq.json()) as { method: string } | null)?.method).toBe(ADDON_ID);
  });
});
