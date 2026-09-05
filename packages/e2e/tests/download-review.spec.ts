import { test, expect, type APIRequestContext } from '@playwright/test';
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

/**
 * The review queue as the server offers it — library-global, like
 * `/api/review/count`, so synchronize on the album under test rather than on
 * either scalar (#854, docs/e2e.md).
 */
const reviewQueue = async (request: APIRequestContext, token: string) =>
  (
    (await (await request.get('/api/review/queue', { headers: bearer(token) })).json()) as {
      albums: Array<{ albumId: string; albumArtist: string; albumTitle: string }>;
    }
  ).albums;

/** The row these tests create: the copy carries the fixture single's tags, so
 *  it quarantines under that album's identity (`albumIdFor(artist, album)`).
 *  Matched on both fields — artist alone still picks by queue order if the
 *  artist ever holds a second album. */
const heldAlbum = async (request: APIRequestContext, token: string) =>
  (await reviewQueue(request, token)).find(
    (a) => a.albumArtist === FIXTURE.single.artist && a.albumTitle === FIXTURE.single.title,
  ) ?? null;

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

    await expect
      .poll(async () => (await heldAlbum(request, token))?.albumId ?? null)
      .not.toBeNull();
    const heldAlbumId = (await heldAlbum(request, token))!.albumId;

    await page.goto('/downloads');
    await expect(page.getByTestId('review-inbox')).toBeVisible();

    // Pin every interaction to that album, not to queue order (docs/e2e.md).
    const heldRow = page.locator(`[data-testid="review-album"][data-album-id="${heldAlbumId}"]`);
    await expect(heldRow).toBeVisible();

    // #746: approving must not mean trusting a bare count — the card names the
    // tracks it is asking about.
    const tracklist = heldRow.getByTestId('review-tracklist');
    await expect(tracklist).toBeVisible();
    await tracklist.click();
    await expect(heldRow.getByTestId('review-tracklist-row').first()).toBeVisible();

    // Assert the approve actually reached the server, so "a foreign album
    // pinned the queue" and "the click was swallowed" stay distinguishable.
    const approved = page.waitForResponse(
      (r) => /\/api\/review\/albums\/.*\/approve$/.test(r.url()) && r.request().method() === 'POST',
    );
    await heldRow.getByTestId('review-approve').click();
    expect((await approved).status()).toBeLessThan(400);

    // The album under test left the queue. Deliberately NOT "the library has
    // zero pending albums" — this test never created those and cannot control
    // them.
    await expect
      .poll(async () => (await reviewQueue(request, token)).map((a) => a.albumId))
      .not.toContain(heldAlbumId);
  });

  // #808: "Approve all" is one bulk request now — the count drops immediately
  // and no reload can strand a half-swept queue (the old client loop of
  // blocking per-album POSTs took minutes and died with the page).
  test('Approve all clears the queue in one request, live', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const token = ((await login.json()) as { token: string }).token;
    await request.put('/api/admin/processing', {
      headers: bearer(token),
      data: { holdForReview: true },
    });

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
    await page.getByTestId('review-approve-all').click();
    await page.getByTestId('confirm-ok').click();

    // The inbox empties without any reload — the optimistic drop + the bulk
    // response, not a 30 s poll, own the count.
    await expect(page.getByTestId('review-inbox')).toHaveCount(0, { timeout: 15_000 });
    // The one place a library-global `pending === 0` is honest: Approve all
    // sweeps the whole queue by design — including any foreign row, which
    // later specs inherit as approved.
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

    // Identity, not `queue()[0]` — the queue is library-wide (docs/e2e.md).
    await expect
      .poll(async () => (await heldAlbum(request, token))?.albumId ?? null)
      .not.toBeNull();
    const heldAlbumId = (await heldAlbum(request, token))!.albumId;

    await page.goto('/downloads');
    await expect(page.getByTestId('review-inbox')).toBeVisible();

    // Pin the click to that album, not to queue order (docs/e2e.md).
    const heldRow = page.locator(`[data-testid="review-album"][data-album-id="${heldAlbumId}"]`);
    await expect(heldRow).toBeVisible();
    // Assert the discard actually reached the server. Without this, "a foreign
    // album pinned the count" and "the click was swallowed" look identical.
    const discarded = page.waitForResponse(
      (r) => /\/api\/review\/albums\/.*\/discard$/.test(r.url()) && r.request().method() === 'POST',
    );
    await heldRow.getByTestId('review-discard').click();
    await page.getByTestId('confirm-ok').click();
    expect((await discarded).status()).toBeLessThan(400);

    // The album under test is gone. Deliberately NOT "the library has zero
    // pending albums" — this test never created those and cannot control them.
    await expect
      .poll(async () => (await reviewQueue(request, token)).map((a) => a.albumId))
      .not.toContain(heldAlbumId);

    // The held file is gone from disk, and the discard is scoped to the held
    // album only — the original fixture single survives (verified empirically:
    // deleteAlbum acts on the queue's albumId, whose songs are the held
    // copies). The backup/restore in afterEach stays as insurance in case
    // those semantics ever widen.
    expect(existsSync(join(REVIEW_DIR, 'review-track.flac'))).toBe(false);
    expect(existsSync(SRC)).toBe(true);
  });
});
