import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, AUTH_FILE, bearer, waitForLibrary } from '../helpers';

/**
 * Setup project (runs before every other project). Seeds the admin user, kicks a
 * library scan of the committed fixtures, and saves an authenticated
 * storageState that the chromium project reuses. Idempotent across re-runs: if
 * the DB wasn't wiped (e.g. reuseExistingServer locally), it logs in instead.
 */
setup('seed admin + library', async ({ page, request }) => {
  const status = (await (await request.get('/api/setup/status')).json()) as {
    needsSetup: boolean;
  };

  let token: string;
  if (status.needsSetup) {
    const res = await request.post('/api/setup/complete', {
      data: { admin: { username: ADMIN.username, password: ADMIN.password } },
    });
    expect(res.status(), 'setup/complete should create the first admin').toBe(201);
    token = ((await res.json()) as { token: string }).token;
  } else {
    const res = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(res.ok(), 'admin login should succeed on a reused server').toBeTruthy();
    token = ((await res.json()) as { token: string }).token;
  }

  // Kick a scan of the fixture music dir and wait for it to land.
  await request.post('/api/system/scan', { headers: bearer(token) });
  await waitForLibrary(request, token);

  // Persist auth into localStorage (the web app reads nicotind_token/_username/_role)
  // and snapshot it for the chromium project.
  await page.goto('/login');
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem('nicotind_token', t);
      localStorage.setItem('nicotind_username', u);
      localStorage.setItem('nicotind_role', 'admin');
    },
    { t: token, u: ADMIN.username },
  );
  mkdirSync('.auth', { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
