import { test, expect } from '../helpers';

/**
 * Retry on a failed album (#1511). The route's outcomes are covered in
 * downloads.test.ts, and e2e has no Lidarr to re-hunt through (#1547), so this
 * stubs the feed and guards the part only a browser sees: that a failed album
 * offers the buttons, and that clicking them reaches the right endpoint.
 */
const failedAlbum = (id: string, title: string) => ({
  id,
  kind: 'album-hunt',
  method: 'fixture-addon',
  state: 'failed',
  stage: 'error',
  artistName: 'Retry Artist',
  albumTitle: title,
  displayTitle: null,
  lidarrAlbumId: 77,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  error: 'Cancelled by user',
  progress: { expected: 1, delivered: 0, unavailable: 0, failed: 1, canonical: 1 },
  items: [],
  sources: [],
  destinationAlbums: [],
});

test.describe('retrying a failed album', () => {
  test('a failed album offers Retry and Retry failed, and both reach the job route', async ({
    page,
  }) => {
    // A finished card keeps the section on screen once the failed ones are gone.
    const done = { ...failedAlbum('d1', 'Done Album'), state: 'done', stage: 'done', error: null };
    let jobs = [failedAlbum('r1', 'First Album'), failedAlbum('r2', 'Second Album'), done];
    const retried: string[] = [];
    await page.route('**/api/downloads/jobs', (route) => route.fulfill({ json: jobs }));
    await page.route('**/api/downloads/jobs/*/retry', (route) => {
      const id = /jobs\/([^/]+)\/retry/.exec(route.request().url())![1]!;
      retried.push(id);
      jobs = jobs.filter((j) => j.id !== id);
      return route.fulfill({ status: 201, json: { outcome: 'enqueued' } });
    });

    await page.goto('/get?tab=activity');
    const bulk = page.getByTestId('downloads-retry-failed');
    await expect(bulk).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('download-retry')).toHaveCount(2);

    // One card first, then the rest through the header button.
    await page.getByTestId('download-retry').first().click();
    await expect.poll(() => retried.length).toBe(1);
    await expect(page.getByTestId('download-retry')).toHaveCount(1, { timeout: 15_000 });

    await bulk.click();
    await expect.poll(() => retried.length).toBe(2);
    expect([...retried].sort()).toEqual(['r1', 'r2']);

    // Nothing left to retry: the button hides in place rather than leaving the DOM.
    await expect(bulk).toBeHidden({ timeout: 15_000 });
    await expect(bulk).toHaveCount(1);
  });
});
