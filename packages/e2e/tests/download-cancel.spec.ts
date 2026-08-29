import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';
import { startFixtureAddon, FIXTURE_ADDON_TOKEN, type FixtureAddon } from './helpers/fixture-addon';

const ADDON_ID = 'fixture-cancel-addon';
const ADDON_AUTH = { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` };

/**
 * Byte progress + reactive cancel on the Downloads card (#805/#806).
 *
 * The fixture addon runs with `deferCancel`, modelling an addon that is slow to
 * act on a cancel — the exact window that used to render as "nothing happened":
 * the card kept pulsing Downloading and the ✕ kept firing. Now the durable
 * `cancel_requested_at` marker owns that window: the chip appears instantly,
 * survives a reload, and the card closes when the addon confirms (or, in prod,
 * when the poller's grace valve gives up on it).
 */
test.describe('byte progress + cancel on an addon download', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({ id: ADDON_ID, deferCancel: true });
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
    // Drop the cancelled feed row so later specs' feeds start clean.
    const res = await request.get('/api/downloads/jobs', { headers: auth });
    if (res.ok()) {
      const jobs = (await res.json()) as Array<{ id: string; method: string }>;
      for (const j of jobs.filter((j) => j.method === ADDON_ID)) {
        await request.delete(`/api/downloads/jobs/${j.id}`, { headers: auth }).catch(() => {});
      }
    }
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  test('bytes drive the bar; cancel reacts instantly, is durable, and closes on confirm', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: ADDON_AUTH,
      data: { intent: 'album', artist: 'Cancel Artist', album: 'Cancel Album' },
    });
    expect(created.status()).toBe(201);

    // Mirrored into the feed with byte progress once the addon reports it.
    addon.advanceBytes(0.4);
    let jobId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return null;
          const jobs = (await res.json()) as Array<{
            id: string;
            method: string;
            progress: { bytesTransferred: number | null; bytesTotal: number | null };
          }>;
          const job = jobs.find((j) => j.method === ADDON_ID);
          if (job) jobId = job.id;
          return job?.progress.bytesTransferred ?? null;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // The card renders the bytes-weighted bar (40% of the single item's size).
    await page.goto('/downloads');
    const card = page.getByTestId('download-cancel');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('40%')).toBeVisible();

    // Cancel: the chip replaces the ✕ before the addon has acted at all.
    await card.click();
    await expect(page.getByTestId('download-cancelling')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('download-cancel')).toHaveCount(0);
    await expect.poll(() => addon.cancelRequests.length).toBe(1);

    // Idempotent: a repeat API cancel is a no-op, not a second addon call.
    const repeat = await request.post(`/api/downloads/jobs/${jobId}/cancel`, { headers: auth });
    expect(repeat.status()).toBe(200);
    expect(((await repeat.json()) as { pending?: boolean }).pending).toBe(true);
    expect(addon.cancelRequests).toHaveLength(1);

    // Durable: the marker — not component state — drives the chip after a reload.
    await page.reload();
    await expect(page.getByTestId('download-cancelling')).toBeVisible({ timeout: 15_000 });

    // The addon finally acts; the poller closes the card out of the live stages.
    addon.confirmCancels();
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return '';
          const jobs = (await res.json()) as Array<{ id: string; stage: string }>;
          return jobs.find((j) => j.id === jobId)?.stage ?? '';
        },
        { timeout: 20_000 },
      )
      .toBe('error');
  });
});
