import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, ADMIN, FIXTURE, bearer } from '../helpers';

/**
 * The lyrics timing editor end to end (#1675): untimed words become timed by
 * stamping each line at the playhead, and karaoke then follows them.
 */
const LINES = ['first line', 'second line', 'third line'];

/**
 * The single, which carries no lyrics of its own: the album's first track holds
 * the karaoke fixture other specs read (`KARAOKE_FIXTURE_LYRICS`).
 */
async function singleSong(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(
    `/api/library/songs?size=200&q=${encodeURIComponent(FIXTURE.single.title)}`,
    { headers: bearer(token) },
  );
  const songs = (await res.json()) as Array<{ id: string; title: string }>;
  const song = songs.find((s) => s.title === FIXTURE.single.title);
  expect(song, `the fixture single "${FIXTURE.single.title}" is in the library`).toBeTruthy();
  return song!.id;
}

/** Play the single from the Songs tab and open the Lyrics tab of Now Playing. */
async function openSingleLyrics(page: Page): Promise<void> {
  await page.goto('/library');
  await page
    .getByTestId('library-tabs')
    .getByRole('button', { name: 'Songs', exact: true })
    .click();
  const row = page.locator('app-track-row').filter({ hasText: FIXTURE.single.title }).first();
  await row.getByTestId('track-row-title').click();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  await page.getByTestId('now-playing-tab-lyrics').click();
}

test.describe('lyrics timing editor', () => {
  let token: string;
  let songId: string;

  test.beforeEach(async ({ request }) => {
    token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as {
        token: string;
      }
    ).token;
    songId = await singleSong(request, token);
    await request.put(`/api/library/songs/${songId}/lyrics`, {
      headers: bearer(token),
      data: { plain: LINES.join('\n') },
    });
  });

  test.afterEach(async ({ request }) => {
    await request.delete(`/api/library/songs/${songId}/lyrics`, { headers: bearer(token) });
  });

  test('stamping every line while the song plays saves timed lyrics that karaoke follows', async ({
    page,
    request,
  }) => {
    await openSingleLyrics(page);
    const panel = page.getByTestId('now-playing-lyrics');
    await expect(panel).toContainText('first line');
    await expect(panel.locator('[data-karaoke-line]')).toHaveCount(0);

    await page.getByTestId('lyrics-options-toggle').click();
    await page.getByTestId('lyrics-edit-timing').click();
    const editor = page.getByTestId('lyrics-timing-editor');
    await expect(editor).toBeVisible();
    const rows = editor.getByTestId('lyrics-timing-row');
    await expect(rows).toHaveCount(LINES.length);
    const save = editor.getByTestId('lyrics-timing-save');
    await expect(save).toBeDisabled();

    // Stamps are the audio element's clock, so wait for it to move between them.
    const clock = () =>
      page.evaluate(() =>
        Math.max(...[...document.querySelectorAll('audio')].map((a) => a.currentTime)),
      );
    let last = -1;
    for (let i = 0; i < LINES.length; i++) {
      await expect.poll(clock).toBeGreaterThan(last + 0.4);
      last = await clock();
      await editor.getByTestId('lyrics-timing-stamp').click();
      await expect(rows.nth(i).getByTestId('lyrics-timing-time')).not.toHaveText('—:—');
    }
    await expect(save).toBeEnabled();
    await save.click();
    await expect(editor).toHaveCount(0);

    const stored = (await (
      await request.get(`/api/library/songs/${songId}/lyrics`, { headers: bearer(token) })
    ).json()) as { plain: string; synced: string; offsetMs: number; customized: boolean };
    expect(stored.plain).toBe(LINES.join('\n'));
    expect(stored.offsetMs).toBe(0);
    expect(stored.customized).toBe(true);
    const stamps = [...stored.synced.matchAll(/\[(\d+):(\d+)\.(\d+)\]/g)].map(
      // A stamp off the centisecond grid is written with three digits.
      (m) => Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10 ** m[3]!.length,
    );
    expect(stamps).toHaveLength(LINES.length);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThan(0.3);

    // The same words are now timed lines in the karaoke view.
    await expect(panel.locator('[data-karaoke-line]')).toHaveCount(LINES.length);
  });

  test('Cancel leaves the stored lyrics as they were', async ({ page, request }) => {
    await openSingleLyrics(page);
    await page.getByTestId('lyrics-options-toggle').click();
    await page.getByTestId('lyrics-edit-timing').click();
    const editor = page.getByTestId('lyrics-timing-editor');
    await editor.getByTestId('lyrics-timing-stamp').click();
    await editor.getByTestId('lyrics-timing-cancel').click();
    await expect(editor).toHaveCount(0);
    const stored = (await (
      await request.get(`/api/library/songs/${songId}/lyrics`, { headers: bearer(token) })
    ).json()) as { synced: string | null };
    expect(stored.synced).toBeNull();
  });
});
