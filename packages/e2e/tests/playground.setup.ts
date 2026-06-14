import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, bearer, waitForLibrary } from '../helpers';

/**
 * Auth setup for the gated `playground` project. Works in two modes:
 *   - managed server (no E2E_BASE_URL): first run -> creates the e2e admin,
 *     scans the committed fixtures, so the playground can run degraded.
 *   - live backend (E2E_BASE_URL): logs in with PLAYGROUND_USERNAME /
 *     PLAYGROUND_PASSWORD (falling back to the e2e admin creds), never mutates
 *     setup state.
 * Saves an authenticated storageState the playground project reuses.
 */
const PLAYGROUND_AUTH = '.auth/playground.json';

setup('playground auth', async ({ page, request }) => {
  const username = process.env.PLAYGROUND_USERNAME ?? ADMIN.username;
  const password = process.env.PLAYGROUND_PASSWORD ?? ADMIN.password;

  const status = (await (await request.get('/api/setup/status')).json()) as {
    needsSetup: boolean;
  };

  let token: string;
  if (status.needsSetup) {
    const res = await request.post('/api/setup/complete', {
      data: { admin: { username, password } },
    });
    expect(res.status(), 'setup/complete should create the first admin').toBe(201);
    token = ((await res.json()) as { token: string }).token;
    // Managed server: scan the fixture library so flows have something to render.
    await request.post('/api/system/scan', { headers: bearer(token) });
    await waitForLibrary(request, token);
  } else {
    const res = await request.post('/api/auth/login', { data: { username, password } });
    expect(res.ok(), `login should succeed for "${username}"`).toBeTruthy();
    token = ((await res.json()) as { token: string }).token;
  }

  await page.goto('/login');
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem('nicotind_token', t);
      localStorage.setItem('nicotind_username', u);
      localStorage.setItem('nicotind_role', 'admin');
    },
    { t: token, u: username },
  );
  mkdirSync('.auth', { recursive: true });
  await page.context().storageState({ path: PLAYGROUND_AUTH });
});
