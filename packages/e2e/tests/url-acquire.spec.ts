import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';
import { startFixtureAddon, FIXTURE_ADDON_TOKEN, type FixtureAddon } from './helpers/fixture-addon';

/**
 * The `url`/`resolve` acquisition-addon seam: a resolve-capable addon declares
 * `urlPatterns`, a `url`-intent job created on it is mirrored into the unified
 * downloads feed as a `kind:url` job (the `KIND_BY_INTENT` url mapping + feed
 * unification, fixing #509 cause 1). The addon→feed→ingest→library half of the
 * loop is proven by addon-acquire.spec through the same poller; here we prove the
 * url intent flows through it, without landing (no fixture-tree collision).
 */
test.describe('url acquisition through a resolve addon', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({
      id: 'fixture-url-addon',
      capabilities: ['resolve'],
      urlPatterns: ['^https?://fixture\\.test/'],
    });
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
    const enabled = await request.post('/api/plugins/fixture-url-addon/enable', {
      headers: auth,
      data: { consent: true },
    });
    expect(enabled.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request
      .delete('/api/plugins/addons/fixture-url-addon', { headers: auth })
      .catch(() => {});
    await addon.close();
  });

  test('a url-intent job is mirrored into the unified downloads feed', async ({ request }) => {
    // Create a url resolve job addon-side (the shape the acquire route sends).
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` },
      data: {
        intent: 'url',
        url: 'https://fixture.test/track',
        artist: 'Addon Artist',
        album: 'Addon Album',
      },
    });
    expect(created.status()).toBe(201);

    // The poller (5s cadence) maps the url intent to a kind:url row and mirrors
    // it into the unified feed — the same feed slskd/hunt jobs use.
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return false;
          const jobs = (await res.json()) as Array<{ albumTitle: string | null; method: string }>;
          return jobs.some(
            (j) => j.albumTitle === 'Addon Album' && j.method === 'fixture-url-addon',
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});
