import { test, expect } from '../helpers';
import { ADMIN, bearer } from '../helpers';
import {
  startFixtureAddon,
  FIXTURE_ADDON_TOKEN,
  RICK_ASTLEY_PAYLOAD,
  type FixtureAddon,
  type FixturePayload,
} from './helpers/fixture-addon';

const ADDON_ID = 'fixture-all-copies-addon';
const PAYLOAD: FixturePayload = {
  ...RICK_ASTLEY_PAYLOAD,
  filename: 'Music\\All Copies\\01 Never Gonna Give You Up.flac',
};

/**
 * The Advanced lane was a second results page under the first. Every copy the
 * network search saw now sits behind one row that opens Choose a copy.
 */
test.describe('all copies on the source', () => {
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
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  test('one row opens every folder in the picker, with its files', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/get?tab=add');
    await page.getByTestId('search-input').fill(PAYLOAD.title);
    await page.getByTestId('search-submit').click();

    const allCopies = page.getByTestId('advanced-toggle');
    await expect(allCopies).toBeEnabled({ timeout: 20_000 });
    // The lane's own folder and song lists are gone from the page.
    await expect(page.getByTestId('network-view-folders')).toHaveCount(0);
    await allCopies.click();

    const picker = page.getByTestId('copy-picker');
    await expect(picker).toBeVisible();
    const row = picker.getByTestId('copy-row').filter({ hasText: 'All Copies' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await picker.getByTestId('copy-picker-files').click();
    await expect(picker.getByTestId('copy-file-get')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('a track query tops with the track, and the scope chip lives in the URL', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto('/get?tab=add');
    await page.getByTestId('search-input').fill(PAYLOAD.title);
    await page.getByTestId('search-submit').click();

    const top = page.getByTestId('top-result');
    await expect(top).toHaveAttribute('data-kind', 'track', { timeout: 20_000 });
    await expect(top.getByTestId('acquire-result')).toContainText(PAYLOAD.title);

    await page.getByTestId('scope-tracks').click();
    await expect(page).toHaveURL(/[?&]scope=tracks/);
    await expect(page.getByTestId('top-result')).toHaveCount(0);
    await page.getByTestId('scope-all').click();
    await expect(page).not.toHaveURL(/scope=/);
  });
});
