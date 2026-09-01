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

const ADDON_ID = 'fixture-discard-addon';
const ADDON_AUTH = { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` };
const LANDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/music/Rick Astley');

/**
 * #810: a download whose tracks are held for review is a decision point, not
 * an opaque "Processing" card. The rickroll lands quarantined behind the
 * review hold; the card shows "held for review" with Review/Discard, and
 * Discard (confirmed) deletes exactly what this job landed.
 */
test.describe('partial discard from the download card', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

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

    const hold = await request.put('/api/admin/processing', {
      headers: auth,
      data: { holdForReview: true },
    });
    expect(hold.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request
      .put('/api/admin/processing', { headers: auth, data: { holdForReview: false } })
      .catch(() => {});
    const res = await request.get('/api/downloads/jobs', { headers: auth });
    if (res.ok()) {
      const jobs = (await res.json()) as Array<{ id: string; method: string }>;
      for (const j of jobs.filter((j) => j.method === ADDON_ID)) {
        await request.delete(`/api/downloads/jobs/${j.id}`, { headers: auth }).catch(() => {});
      }
    }
    rmSync(LANDED_DIR, { recursive: true, force: true });
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  test('a held partial shows Review/Discard on the card, and Discard removes it', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: ADDON_AUTH,
      data: { intent: 'album', artist: 'Rick Astley', album: 'Whenever You Need Somebody' },
    });
    expect(created.status()).toBe(201);
    addon.completeJobs();

    // Ingested but held: the job carries a quarantined track and the review
    // inbox counts it. Capture this job's own id — the hunt-download spec's
    // done job points at the same landed song (same path → same sha1 id), so
    // both cards can honestly carry the held line, and only a locator scoped
    // to the job *this* spec created is safe to discard.
    let jobId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return 0;
          const jobs = (await res.json()) as Array<{
            id: string;
            method: string;
            quarantinedCount?: number;
          }>;
          const job = jobs.find((j) => j.method === ADDON_ID);
          jobId = job?.id ?? '';
          return job?.quarantinedCount ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    expect(jobId).not.toBe('');

    await page.goto('/downloads');
    const card = page.locator(`[data-job-id="${jobId}"]`);
    const held = card.getByTestId('download-held-review');
    await expect(held).toBeVisible({ timeout: 15_000 });

    await card.getByTestId('download-discard-partial').click();
    await page.getByTestId('confirm-ok').click();

    // The held track is gone from the review queue and from the feed row.
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/review/count', { headers: auth });
          return res.ok() ? ((await res.json()) as { pending: number }).pending : -1;
        },
        { timeout: 20_000 },
      )
      .toBe(0);
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return -1;
          const jobs = (await res.json()) as Array<{
            method: string;
            quarantinedCount?: number;
          }>;
          return jobs.find((j) => j.method === ADDON_ID)?.quarantinedCount ?? 0;
        },
        { timeout: 20_000 },
      )
      .toBe(0);
  });
});
