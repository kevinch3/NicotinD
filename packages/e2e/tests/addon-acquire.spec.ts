import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, bearer } from '../helpers';
import { startFixtureAddon, FIXTURE_ADDON_TOKEN, type FixtureAddon } from './helpers/fixture-addon';

/** The ingested release lands INSIDE the git-tracked fixtures/music tree —
 *  it must be removed on the way out or every later run inherits it. */
const LANDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/music/Addon Artist');

/**
 * Phase 2 of the acquisition addon protocol: with a remote addon registered and
 * enabled, a job created on the addon is mirrored into the unified downloads
 * feed by the AddonJobPoller, and a finished file is fetched over HTTP and
 * ingested through the organize→scan pipeline — the "Addon Artist" album
 * exists ONLY inside the fixture addon, so its appearance in the library is
 * proof of the whole loop.
 */
test.describe('acquire through a remote addon', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;
  let landedAlbumId = '';

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon();
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
    const enabled = await request.post('/api/plugins/fixture-addon/enable', {
      headers: auth,
      data: { consent: true },
    });
    expect(enabled.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    // Remove the landed release (DB + files) + the registration so the suite
    // stays order-independent. The albumId is captured by the test itself; the
    // filesystem sweep is the backstop — the release lands inside the
    // git-tracked fixtures tree, so residue would dirty the working tree and
    // leak into every later run.
    if (landedAlbumId) {
      await request
        .delete(`/api/library/albums/${landedAlbumId}`, { headers: auth })
        .catch(() => {});
    }
    rmSync(LANDED_DIR, { recursive: true, force: true });
    await request.delete('/api/plugins/addons/fixture-addon', { headers: auth });
    await addon.close();
  });

  test('addon job → feed card → HTTP ingest → album lands in the library', async ({ request }) => {
    // Create a job addon-side (the browse-grab shape any provider enqueue uses).
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` },
      data: { intent: 'album', artist: 'Addon Artist', album: 'Addon Album' },
    });
    expect(created.status()).toBe(201);

    // The poller (5s cadence) mirrors it into the unified job feed.
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return false;
          const jobs = (await res.json()) as Array<{ albumTitle: string | null; method: string }>;
          return jobs.some((j) => j.albumTitle === 'Addon Album' && j.method === 'fixture-addon');
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // Finish the download addon-side; the poller fetches the file over HTTP,
    // runs it through organize → scan (the lossless→Opus standardization
    // included), and the job resolves done with a deep-linkable albumId.
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
          const job = jobs.find((j) => j.albumTitle === 'Addon Album');
          if (job?.stage === 'done' && job.albumId) {
            albumId = job.albumId;
            landedAlbumId = job.albumId;
          }
          return job?.stage ?? '';
        },
        { timeout: 30_000 },
      )
      .toBe('done');

    // The landed release is a 1-track single (hidden from the Albums grid by
    // classification), so assert via the feed's deep link — the same one the
    // Downloads card's "Open in Library" uses.
    const detailRes = await request.get(`/api/library/albums/${albumId}`, { headers: auth });
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as {
      name: string;
      artist: string;
      song: Array<{ id: string; title: string }>;
    };
    expect(detail.artist).toBe('Addon Artist');
    expect(detail.song.some((s) => s.title === 'Addon Song')).toBe(true);

    // Provenance recorded under the addon id.
    const acq = await request.get(`/api/library/songs/${detail.song[0]!.id}/acquisition`, {
      headers: auth,
    });
    expect(acq.status()).toBe(200);
    const provenance = (await acq.json()) as { method: string } | null;
    expect(provenance?.method).toBe('fixture-addon');
  });
});
