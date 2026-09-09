import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';
import { startFixtureAddon, FIXTURE_ADDON_TOKEN, type FixtureAddon } from './helpers/fixture-addon';

const ADDON_ID = 'fixture-resource-addon';
const ADDON_AUTH = { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` };
const ALTERNATE = 'other-peer';

/**
 * Re-sourcing a stuck download from another peer (#1065).
 *
 * The case this exists for: a hunt commits to one peer's folder, that peer
 * never uploads, and the card sits at "0 of N · PENDING" with nothing to do
 * about it but throw the job away. The assertion that matters is that the
 * replacement lands on the SAME card — a second card would be the old
 * cancel-and-re-hunt workaround with extra steps.
 */
test.describe('re-source a stuck download', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({ id: ADDON_ID, alternatePeer: ALTERNATE });
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

  test('hands the pending track to another peer, on the same card', async ({ page, request }) => {
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: ADDON_AUTH,
      data: { intent: 'album', artist: 'Addon Artist', album: 'Addon Album' },
    });
    expect(created.status()).toBe(201);

    // Mirrored into the feed, stuck on the original peer.
    let jobId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return null;
          const jobs = (await res.json()) as Array<{
            id: string;
            method: string;
            canResource?: boolean;
          }>;
          const job = jobs.find((j) => j.method === ADDON_ID);
          if (job) jobId = job.id;
          return job?.canResource ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    await page.goto('/downloads');
    // Keyed on the job id, not the album title: the fixture payload's "Addon
    // Album" is shared with several other specs, whose cards are still in the
    // feed when the whole suite runs.
    const card = page.locator(`[data-testid="download-item"][data-job-id="${jobId}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // The action is reachable WITHOUT expanding — the stuck card is the point.
    await card.getByTestId('download-resource').click();

    // The picker searches, then offers the alternate peer. The peer already on
    // the job must not be among the options: that is the same dead end.
    const picker = page.getByTestId('resource-picker');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(picker.getByTestId('resource-alternate')).toHaveCount(1, { timeout: 20_000 });
    await expect(picker.getByTestId('resource-alternate')).toHaveAttribute('data-peer', ALTERNATE);

    await picker.getByTestId('resource-confirm').click();
    await expect(picker).toBeHidden({ timeout: 15_000 });

    // The replacement's item arrives on the SAME job, from the new peer, and
    // the abandoned row stops counting rather than doubling the tracklist.
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return null;
          const jobs = (await res.json()) as Array<{
            id: string;
            sources: { username: string }[];
            items: { username?: string | null }[];
          }>;
          const job = jobs.find((j) => j.id === jobId);
          return job ? job.sources.map((s) => s.username).join(',') : null;
        },
        { timeout: 25_000 },
      )
      .toBe(ALTERNATE);

    // Still one card: re-sourcing is not a second download.
    const cards = await request.get('/api/downloads/jobs', { headers: auth });
    const all = (await cards.json()) as Array<{ method: string }>;
    expect(all.filter((j) => j.method === ADDON_ID)).toHaveLength(1);
  });
});
