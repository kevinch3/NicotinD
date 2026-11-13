import { test, expect } from '../helpers';
import { ADMIN, bearer } from '../helpers';
import {
  startFixtureAddon,
  FIXTURE_ADDON_TOKEN,
  RICK_ASTLEY_PAYLOAD,
  type FixtureAddon,
  type FixturePayload,
} from './helpers/fixture-addon';

const ADDON_ID = 'fixture-cancel-track-addon';
/** A wire path of its own: a row reads its state off the shared feed by `username:filename`. */
const PAYLOAD: FixturePayload = {
  ...RICK_ASTLEY_PAYLOAD,
  filename: 'Music\\Cancel Track\\01 Never Gonna Give You Up.flac',
};

/**
 * A single track got from search could only be stopped from the Activity tab.
 * Its row now carries Cancel while the job runs, and reads Get again after.
 */
test.describe('cancel a track from its row', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({ id: ADDON_ID, payload: PAYLOAD });
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
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

  test('Get, then Cancel from the same row, stops the job and offers Get again', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await page.goto('/get?tab=add');
    await page.getByTestId('search-input').fill(PAYLOAD.title);
    await page.getByTestId('search-submit').click();
    const row = page.getByTestId('acquire-result').filter({ hasText: PAYLOAD.title });
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.getByTestId('acquire-result-get').click();
    const cancel = row.getByTestId('acquire-result-cancel');
    await expect(cancel).toBeVisible({ timeout: 20_000 });
    await cancel.click();

    await expect.poll(() => addon.cancelRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          const jobs = (await res.json()) as Array<{ method: string; state: string }>;
          return jobs.find((j) => j.method === ADDON_ID)?.state ?? '';
        },
        { timeout: 15_000 },
      )
      .not.toBe('active');
    await expect(row.getByTestId('acquire-result-cancel')).toHaveCount(0);
    await expect(row.getByTestId('acquire-result-get')).toBeEnabled();
  });
});
