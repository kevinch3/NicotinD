import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, AUTH_FILE, FIXTURE, bearer, waitForLibrary } from '../helpers';

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

  // Seed lyrics on the first fixture track so the karaoke overlay can render
  // (fixture tracks are silent FLAC with no LRCLIB match, so the panel would
  // be empty without pre-seeded text).
  const albums = (await (
    await request.get('/api/library/albums', { headers: bearer(token) })
  ).json()) as Array<{ id: string; title: string; song: Array<{ id: string }> }>;
  const fixtureAlbum = albums.find((a) => a.title === FIXTURE.album.title);
  if (fixtureAlbum?.song[0]) {
    await request.put(`/api/library/songs/${fixtureAlbum.song[0].id}/lyrics`, {
      headers: bearer(token),
      data: { plain: 'karaoke warmup line\nsecond warmup line' },
    });
  }

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
