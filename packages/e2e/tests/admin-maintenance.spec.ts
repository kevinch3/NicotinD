import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * The maintenance panel after issue #622 turned the whole-library passes into
 * background jobs.
 *
 * Lidarr isn't in the e2e harness, so the pass itself can't run; what matters
 * here is the DOM contract the change introduced — a new `maintenance-cancel`
 * button, a progress block driven by the shared ServiceReview poll, and a
 * start button whose disabled logic now comes from that slice rather than a
 * local signal. Those are exactly the selectors a UI change can silently break.
 */
test.describe('admin maintenance passes', () => {
  test('Stop ships alongside Start and is disabled while nothing runs', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');

    await expect(page.getByTestId('optimize-all-metadata')).toBeVisible();
    const stop = page.getByTestId('maintenance-cancel');
    await expect(stop).toBeVisible();
    await expect(stop).toBeDisabled();
    // Nothing is running, so no progress block is rendered.
    await expect(page.getByTestId('maintenance-progress')).toHaveCount(0);
  });

  test('a running pass renders progress and flips both buttons', async ({ page }) => {
    // Stub the shared review poll so the panel sees a pass in flight. The pass
    // is server state, so this is the only way to reach the running UI without
    // a configured Lidarr.
    await page.route('**/api/admin/review', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      body.maintenance = {
        phase: 'running',
        taskId: 'metadata-optimize',
        label: 'Optimize metadata',
        total: 10,
        visited: 4,
        lastItems: ['Aphex Twin — Drukqs'],
        detail: {},
        dryRun: false,
        params: 'apply',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        lastOutcome: null,
        lastError: null,
        startedBy: 'admin',
      };
      await route.fulfill({ response: res, json: body });
    });

    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');

    const progress = page.getByTestId('maintenance-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('4 / 10');
    await expect(progress).toContainText('Aphex Twin — Drukqs');

    // Start is blocked while a pass runs; Stop becomes available.
    await expect(page.getByTestId('optimize-all-metadata')).toBeDisabled();
    await expect(page.getByTestId('maintenance-cancel')).toBeEnabled();
  });

  test('the start endpoint answers immediately rather than holding the request', async ({
    request,
  }) => {
    // The `request` fixture carries no session, so authenticate explicitly.
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok(), 'admin login should succeed').toBeTruthy();
    const token = ((await login.json()) as { token: string }).token;

    // The defect was a handler that ran for minutes. Without Lidarr the task
    // reports itself unavailable, but either way the answer must be instant and
    // must never be a 200 carrying a finished result.
    const started = Date.now();
    const res = await request.post('/api/admin/maintenance/metadata-optimize', {
      headers: bearer(token),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect([202, 503]).toContain(res.status());
  });
});

/**
 * Sync library (#1448): the route answers 202 as soon as the rescan is queued on
 * the maintenance runner, so the button must say it started — never "complete".
 * Routed, because whether this harness wires the runner is not the contract.
 */
test.describe('admin sync library', () => {
  test('a queued rescan reads as started; a busy runner reads as busy', async ({ page }) => {
    let answer: { status: number; json: object } = {
      status: 202,
      json: { ok: true, started: true },
    };
    await page.route('**/api/library/sync', (route) => route.fulfill(answer));
    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');

    await page.getByTestId('sync-library').click();
    const msg = page.getByTestId('sync-library-msg');
    await expect(msg).toContainText('Started');
    await expect(msg).not.toContainText('complete');

    answer = {
      status: 409,
      json: { error: 'A maintenance pass is already running', code: 'MAINTENANCE_RUNNING' },
    };
    await page.getByTestId('sync-library').click();
    await expect(msg).toHaveText('A maintenance pass is already running.');
  });
});

/**
 * Incomplete Albums (#1444): the health report's confirmed worklist, loaded on
 * Check. With no Lidarr no hunt records a tracklist, so the real route can only
 * answer empty; a routed row drives the table and the one-click Complete.
 */
test.describe('admin incomplete albums', () => {
  test('loads nothing until Check, then the real (empty) worklist', async ({ page }) => {
    let reads = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/library/incomplete-albums') reads++;
    });
    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');
    const panel = page.getByTestId('incomplete-albums');
    await expect(panel).toBeVisible();
    expect(reads).toBe(0);

    await panel.getByTestId('incomplete-albums-check').click();
    await expect(panel).toContainText('No incomplete albums');
    expect(reads).toBe(1);
  });

  test('a row shows owned of expected, and Complete hunts that album', async ({ page }) => {
    await page.route('**/api/library/incomplete-albums', (route) =>
      route.fulfill({
        json: [
          {
            albumId: null,
            artist: 'Soda Stereo',
            album: 'Canción Animal',
            expected: 11,
            owned: 9,
            missing: 2,
            lidarrAlbumId: 4242,
            state: 'done',
          },
        ],
      }),
    );
    const hunts: string[] = [];
    await page.route('**/api/discography/albums/4242/hunt/base', (route) => {
      hunts.push(route.request().method());
      return route.fulfill({ json: { candidates: [], totalTracks: 11, skewNeeded: false } });
    });

    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');
    const panel = page.getByTestId('incomplete-albums');
    await panel.getByTestId('incomplete-albums-check').click();

    const row = panel.getByTestId('incomplete-album-row');
    await expect(row).toContainText('Canción Animal');
    await expect(row).toContainText('9 of 11');
    const complete = row.getByTestId('incomplete-album-complete');
    await expect(complete).toHaveText('Complete album');
    await complete.click();

    await expect(
      page.getByTestId('toast').filter({ hasText: 'No confident match found' }),
    ).toBeVisible();
    expect(hunts).toEqual(['POST']);
    await expect(complete).toBeEnabled();
  });
});
