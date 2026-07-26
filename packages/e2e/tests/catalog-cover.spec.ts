import { expect, test } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';

/**
 * Issue #263 — catalog (Lidarr/MusicBrainz) covers used to be handed to the
 * browser as third-party 1200 px CDN originals (measured on prod at 878 KB for
 * seven ~150 px tiles), or as a Lidarr-relative `/MediaCover/…` path the
 * browser resolves against NicotinD's origin and 404s. Both now go through
 * `GET /api/cover/remote`, which downscales and disk-caches server-side.
 *
 * The e2e environment has no Lidarr (it points at a dead 127.0.0.1:1), so the
 * catalog grid itself can't be driven here — the *proxy route contract* is the
 * part that is both testable and where the bug lived. Cover mapping and the
 * allowlist are unit-tested in `services/remote-cover.test.ts`; the card markup
 * swap is covered by the web unit specs.
 */
test.describe('catalog cover proxy (#263)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    // The `request` fixture is NOT authenticated — log in explicitly.
    const res = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    token = (await res.json()).token;
  });

  test('rejects a missing or non-allowlisted upstream without fetching it', async ({ request }) => {
    // No `u` at all.
    expect((await request.get('/api/cover/remote', { headers: bearer(token) })).status()).toBe(400);

    // An open proxy would be an SSRF hole: arbitrary hosts, and the cloud
    // metadata endpoint in particular, must be refused before any request.
    for (const u of [
      'https://evil.example.com/x.jpg',
      'http://169.254.169.254/latest/meta-data/',
      'https://images.lidarr.audio.evil.com/x.jpg',
      'file:///etc/passwd',
    ]) {
      const res = await request.get(`/api/cover/remote?u=${encodeURIComponent(u)}`, {
        headers: bearer(token),
      });
      expect(res.status(), `should refuse ${u}`).toBe(400);
    }
  });

  test('an unreachable upstream 404s instead of hanging or 500ing', async ({ request }) => {
    // Allowlisted host, URL that resolves to nothing. The card must get a status
    // it can render as its placeholder — the old raw <img> just stayed blank
    // forever. Whether CI has egress or not, the outcome is the same 404.
    const upstream =
      'https://coverartarchive.org/release/00000000-0000-0000-0000-000000000000/x.jpg';
    const started = Date.now();
    const res = await request.get(`/api/cover/remote?u=${encodeURIComponent(upstream)}`, {
      headers: bearer(token),
    });

    expect(res.status()).toBe(404);
    // The route caps the upstream fetch (6s) so one dead CDN can't tie up a
    // browser connection slot behind a grid of tiles.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test('the search page renders catalog tiles through the shared cover component', async ({
    page,
  }) => {
    await page.goto('/search');
    // With no Lidarr there are no catalog cards to assert on, so this only
    // pins that the page still loads with the cover-component swap in place —
    // a broken `app-cover-art` import would blank the whole route.
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.locator('text=/error|cannot read/i').first()).toBeHidden();
  });
});
