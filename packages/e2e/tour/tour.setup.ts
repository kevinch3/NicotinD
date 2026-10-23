import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { bearer, scanAndWait, waitForLibrary, waitForProcessingIdle } from '../helpers';
import { DEMO_ADDON_ID, DEMO_ADDON_TOKEN } from './demo-addon';
import { DEMO_ADDON_PORT } from './demo-services';

/** The account the viewer sees signed in. Named like a person, not a test fixture. */
export const TOUR_USER = { username: 'alex', password: 'tour-password-123' } as const;

/**
 * Seeds the tour server: first admin, a scan of the demo library, the demo
 * source registered and enabled, the welcome banner dismissed — so the first
 * frame of every shot is the app in use, not the app being set up.
 */
setup('seed the tour server', async ({ page, request }) => {
  setup.setTimeout(300_000);
  const res = await request.post('/api/setup/complete', {
    data: { admin: { username: TOUR_USER.username, password: TOUR_USER.password } },
  });
  expect(res.status(), 'a fresh tour server creates its first admin').toBe(201);
  const token = ((await res.json()) as { token: string }).token;
  const auth = bearer(token);

  await scanAndWait(request, token);
  await waitForLibrary(request, token);
  await waitForProcessingIdle(request, token);

  const registered = await request.post('/api/plugins/addons', {
    headers: auth,
    data: { url: `http://127.0.0.1:${DEMO_ADDON_PORT}`, token: DEMO_ADDON_TOKEN },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const enabled = await request.post(`/api/plugins/${DEMO_ADDON_ID}/enable`, {
    headers: auth,
    data: { consent: true },
  });
  expect(enabled.ok(), await enabled.text()).toBeTruthy();
  await request.post('/api/auth/dismiss-welcome', { headers: auth });

  await page.goto('/login');
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem('nicotind_token', t);
      localStorage.setItem('nicotind_username', u);
      localStorage.setItem('nicotind_role', 'admin');
    },
    { t: token, u: TOUR_USER.username },
  );
  mkdirSync('.auth', { recursive: true });
  await page.context().storageState({ path: '.auth/tour.json' });
});
