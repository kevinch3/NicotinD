import { test, expect } from '@playwright/test';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, bearer, FIXTURE, scanAndWait } from '../helpers';

const MUSIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'music');
// Copy the loose single, not an FIXTURE.album track: the copy quarantines
// under its tag-derived albumId, which — while pending review — hides that
// album from every listing. FIXTURE.album is asserted against by ~15 other
// spec files; FIXTURE.single is used by only one (library.spec.ts), so it's
// the low-collision choice for this suite's first add-file-mid-test flow.
const SRC = join(
  MUSIC,
  FIXTURE.single.artist.replace(/ /g, '_'),
  FIXTURE.single.title.replace(/ /g, '_'),
  '01 - E2E_Lonesome_Single.flac',
);
const REVIEW_DIR = join(MUSIC, 'E2E_Review_Copy');
// Discard runs deleteAlbum (folder-first rmSync) on the held album — which is
// the fixture single's albumId, so the ORIGINAL fixture folder goes with it.
// The discard test backs it up here and afterEach restores it (safe: the suite
// runs with workers: 1, so no other spec observes the gap).
const SINGLE_DIR = dirname(SRC);
const BACKUP_DIR = join(MUSIC, '..', 'e2e-single-backup');

test.describe('download review inbox', () => {
  test.afterEach(async ({ request }) => {
    rmSync(REVIEW_DIR, { recursive: true, force: true });
    if (existsSync(BACKUP_DIR)) {
      // The discard test deleted the single's folder — put the original back.
      cpSync(BACKUP_DIR, SINGLE_DIR, { recursive: true });
      rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const token = ((await login.json()) as { token: string }).token;
    await request.put('/api/admin/processing', {
      headers: bearer(token),
      data: { holdForReview: false },
    });
    await scanAndWait(request, token); // prune the copied song
  });

  test('held download appears in inbox, approve lands it', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const token = ((await login.json()) as { token: string }).token;
    await request.put('/api/admin/processing', {
      headers: bearer(token),
      data: { holdForReview: true },
    });

    cpSync(SRC, join(REVIEW_DIR, 'review-track.flac')); // NOTE: file carries the fixture single's tags —
    // it quarantines under the EXISTING fixture single's albumId, hiding it
    // from the library while pending.
    await scanAndWait(request, token);

    // pending: count > 0
    await expect
      .poll(
        async () =>
          (
            (await (await request.get('/api/review/count', { headers: bearer(token) })).json()) as {
              pending: number;
            }
          ).pending,
      )
      .toBeGreaterThan(0);

    await page.goto('/downloads');
    await expect(page.getByTestId('review-inbox')).toBeVisible();

    // #746: approving must not mean trusting a bare count — the card names the
    // tracks it is asking about.
    const tracklist = page.getByTestId('review-tracklist').first();
    await expect(tracklist).toBeVisible();
    await tracklist.click();
    await expect(page.getByTestId('review-tracklist-row').first()).toBeVisible();

    await page.getByTestId('review-approve').first().click();
    await expect
      .poll(
        async () =>
          (
            (await (await request.get('/api/review/count', { headers: bearer(token) })).json()) as {
              pending: number;
            }
          ).pending,
      )
      .toBe(0);
  });

  // Issue #415: the discard half of the flow, at the e2e level (route-tested
  // before). Discard must delete the held files from disk, not just dismiss
  // the inbox row.
  test('discard removes the held files from disk', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const token = ((await login.json()) as { token: string }).token;
    await request.put('/api/admin/processing', {
      headers: bearer(token),
      data: { holdForReview: true },
    });

    cpSync(SINGLE_DIR, BACKUP_DIR, { recursive: true });
    cpSync(SRC, join(REVIEW_DIR, 'review-track.flac'));
    await scanAndWait(request, token);

    await expect
      .poll(
        async () =>
          (
            (await (await request.get('/api/review/count', { headers: bearer(token) })).json()) as {
              pending: number;
            }
          ).pending,
      )
      .toBeGreaterThan(0);

    await page.goto('/downloads');
    await expect(page.getByTestId('review-inbox')).toBeVisible();
    await page.getByTestId('review-discard').first().click();
    await page.getByTestId('confirm-ok').click();

    await expect
      .poll(
        async () =>
          (
            (await (await request.get('/api/review/count', { headers: bearer(token) })).json()) as {
              pending: number;
            }
          ).pending,
      )
      .toBe(0);

    // The held file is gone from disk, and the discard is scoped to the held
    // album only — the original fixture single survives (verified empirically:
    // deleteAlbum acts on the queue's albumId, whose songs are the held
    // copies). The backup/restore in afterEach stays as insurance in case
    // those semantics ever widen.
    expect(existsSync(join(REVIEW_DIR, 'review-track.flac'))).toBe(false);
    expect(existsSync(SRC)).toBe(true);
  });
});
