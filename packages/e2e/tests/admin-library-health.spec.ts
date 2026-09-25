import { test, expect } from '../helpers';
import { clearGroupState, expandGroup } from '../helpers';

/**
 * The Admin Library health panel (issue #736) against the real report route.
 *
 * Two contracts the unit harness cannot see: the `(opened)` binding that makes
 * the fetch lazy (the JIT vitest harness wires no signal outputs on a nested
 * component), and the real `GET /api/library/health` shape rendering one card
 * per dimension. Card *contents* are left alone — the suite shares one server,
 * so the numbers belong to whichever specs ran before this one.
 */
const DIMENSIONS = [
  'audit',
  'fragments',
  'albumCovers',
  'artistPortraits',
  'genres',
  'years',
  'classification',
  'formatCohesion',
  'completeness',
  'disk',
  'lyrics',
  'duplicateSongs',
  'flags',
];

test.describe('admin library health panel', () => {
  test('fetches only on expand, then renders one card per dimension', async ({ page }) => {
    const healthRequests: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/library/health') healthRequests.push(r.url());
    });

    await page.goto('/admin');
    await clearGroupState(page);
    await page.reload();
    await expect(page.locator('[data-group-id="library-health"]')).toBeVisible();
    // Never on page load: the report issues many point queries.
    expect(healthRequests).toHaveLength(0);

    const loaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/library/health' && r.ok(),
    );
    await expandGroup(page, 'library-health');
    await loaded;

    for (const d of DIMENSIONS) {
      await expect(page.getByTestId(`health-card-${d}`)).toBeVisible();
    }
    await expect(page.getByTestId('library-health-totals')).toBeVisible();
    expect(healthRequests).toHaveLength(1);

    const refreshed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/library/health' && r.ok(),
    );
    await page.getByTestId('library-health-refresh').click();
    await refreshed;
    expect(healthRequests).toHaveLength(2);
  });

  test('the lossless transcode asks the shared confirm host, and Cancel starts nothing', async ({
    page,
  }) => {
    // Force the destructive button on: whether the fixture library still holds
    // lossless files depends on the specs before this one.
    await page.route('**/api/library/health', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as {
        dimensions: { formatCohesion: { metric: { losslessSongs: number } } };
      };
      body.dimensions.formatCohesion.metric.losslessSongs = 5;
      await route.fulfill({ response: res, json: body });
    });
    const maintenancePosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/admin/maintenance/')) {
        maintenancePosts.push(r.url());
      }
    });

    await page.goto('/admin');
    await expandGroup(page, 'library-health');
    const transcode = page.getByTestId('health-action-formatCohesion');
    await expect(transcode).toBeVisible();

    await transcode.click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    expect(maintenancePosts).toEqual([]);
  });
});
