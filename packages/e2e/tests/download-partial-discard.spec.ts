import { test, expect, type APIRequestContext } from '@playwright/test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, bearer } from '../helpers';
import {
  startFixtureAddon,
  FIXTURE_ADDON_TOKEN,
  RICK_ASTLEY_PAYLOAD,
  type FixtureAddon,
} from './helpers/fixture-addon';

const ADDON_ID = 'fixture-discard-addon';
const ADDON_AUTH = { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` };
const LANDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/music/Rick Astley');

/** Audio files under the rickroll's landed folder — the discard's on-disk effect.
 *  The organizer may rename the file, so count formats rather than one path. */
function landedAudioFiles(): number {
  if (!existsSync(LANDED_DIR)) return 0;
  return readdirSync(LANDED_DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
    /\.(flac|opus|mp3|m4a|ogg)$/i.test(f),
  ).length;
}

/** The rickroll always lands at the same path, so its song id (sha1 of that path)
 *  is stable. A row left behind by a crashed run — or by addon-hunt-download.spec.ts,
 *  which writes this same path — makes this spec unwinnable, so it clears its own
 *  precondition rather than inheriting one. */
async function sweepRickAstley(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<void> {
  const byName = await request.get('/api/library/artists/by-name', {
    headers,
    params: { name: 'Rick Astley' },
  });
  if (byName.ok()) {
    const { id } = (await byName.json()) as { id: string };
    const detail = await request.get(`/api/library/artists/${id}`, { headers });
    if (detail.ok()) {
      const artist = (await detail.json()) as {
        albums: Array<{ id: string }>;
        singlesAndEps: Array<{ id: string }>;
      };
      for (const album of [...artist.albums, ...artist.singlesAndEps]) {
        await request.delete(`/api/library/albums/${album.id}`, { headers }).catch(() => {});
      }
    }
  }
  rmSync(LANDED_DIR, { recursive: true, force: true });
}

/**
 * #810: a cancelled download that already landed tracks is a decision point, not
 * an opaque card. One item of the job is delivered and lands (instantly — there is
 * no gate), the job is then cancelled while still active, and the card offers
 * Discard; confirming it deletes exactly what this job landed through
 * `POST /api/downloads/jobs/:id/discard-partial` — album row and file both gone.
 */
test.describe('partial discard from the download card', () => {
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
    await sweepRickAstley(request, auth);

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
    const res = await request.get('/api/downloads/jobs', { headers: auth });
    if (res.ok()) {
      const jobs = (await res.json()) as Array<{ id: string; method: string }>;
      for (const j of jobs.filter((j) => j.method === ADDON_ID)) {
        await request.delete(`/api/downloads/jobs/${j.id}`, { headers: auth }).catch(() => {});
      }
    }
    // Before the rmSync: `rmSync` alone would leave a `library_songs` row behind
    // if the discard under test did not run.
    if (landedAlbumId) {
      await request
        .delete(`/api/library/albums/${landedAlbumId}`, { headers: auth })
        .catch(() => {});
    }
    rmSync(LANDED_DIR, { recursive: true, force: true });
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  test('a cancelled partial offers Discard on the card, and Discard removes what it landed', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: ADDON_AUTH,
      data: { intent: 'album', artist: 'Rick Astley', album: 'Whenever You Need Somebody' },
    });
    expect(created.status()).toBe(201);

    // Deliver the one item while the job itself stays active — the shape of a
    // multi-track download that has landed some tracks and is still fetching the
    // rest. (`completeJobs()` would also close the job, leaving nothing to cancel.)
    const fixtureJob = addon.jobs[addon.jobs.length - 1]!;
    const now = Date.now();
    for (const item of fixtureJob.items) {
      item.state = 'completed';
      item.fileReady = true;
      item.updatedAt = now;
    }
    // A second track that never arrives keeps the job in `downloading`, which
    // is what makes it cancellable: with every item landed the job is simply
    // done, and a done job has nothing to cancel.
    fixtureJob.items.push({
      ...fixtureJob.items[0]!,
      itemId: 't:second-track',
      title: 'Together Forever',
      filename: 'Music\\Rick Astley\\Whenever You Need Somebody\\02 Together Forever.flac',
      state: 'downloading',
      fileReady: false,
      updatedAt: now,
    });
    fixtureJob.updatedAt = now;

    // The track is ingested and lands at once. Capture this job's own id — the
    // hunt-download spec's done job points at the same landed song (same path →
    // same sha1 id), so only a locator scoped to the job *this* spec created is
    // safe to discard.
    let jobId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return '';
          const jobs = (await res.json()) as Array<{
            id: string;
            method: string;
            albumId?: string | null;
          }>;
          const job = jobs.find((j) => j.method === ADDON_ID);
          jobId = job?.id ?? '';
          landedAlbumId = job?.albumId ?? landedAlbumId;
          return landedAlbumId;
        },
        { timeout: 30_000 },
      )
      .not.toBe('');
    expect(jobId).not.toBe('');
    await expect
      .poll(
        async () =>
          (await request.get(`/api/library/albums/${landedAlbumId}`, { headers: auth })).status(),
        { timeout: 30_000 },
      )
      .toBe(200);
    expect(landedAudioFiles()).toBeGreaterThan(0);

    // Cancel from the card while the job is still active: the fixture addon
    // applies the cancel immediately, so the job closes with one landed track.
    await page.goto('/downloads');
    const card = page.locator(`[data-job-id="${jobId}"]`);
    await card.getByTestId('download-cancel').click();
    // With a track already landed, cancel asks what to do with it (#810).
    // Keep it: the point here is the card's own Discard afterwards.
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => addon.cancelRequests.length).toBe(1);

    // The cancelled partial names itself: Discard is offered, and confirming it
    // deletes the landed track (never the destination album by name).
    const discard = card.getByTestId('download-discard-partial');
    await expect(discard).toBeVisible({ timeout: 20_000 });
    await discard.click();
    await page.getByTestId('confirm-ok').click();

    await expect
      .poll(
        async () =>
          (await request.get(`/api/library/albums/${landedAlbumId}`, { headers: auth })).status(),
        { timeout: 20_000 },
      )
      .toBe(404);
    await expect.poll(() => landedAudioFiles()).toBe(0);
    landedAlbumId = '';
  });
});
