import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * The radio chip's variety control (docs/radio.md "Variety chip"): expanding
 * the pill shows the three positions; picking "too different" asks the server
 * for the `similar` strategy on the very next radio fetch, and the position is
 * remembered on the server as this user's default.
 */
test.describe('radio variety chip', () => {
  test('a move steers the next radio fetch and is remembered', async ({ page, request }) => {
    await page.goto('/library');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // Start a seed radio from a known song, then open Now Playing.
    const search = await request.get('/api/search?q=' + encodeURIComponent(FIXTURE.album.title), {
      headers: auth,
    });
    const songs = ((await search.json()) as { local: { songs: Array<{ id: string }> } }).local
      .songs;
    expect(songs.length).toBeGreaterThan(0);
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const firstRow = page.getByTestId('track-row').first();
    await expect(firstRow).toBeVisible();
    await firstRow.getByTestId('track-row-menu-toggle').click();
    await page.getByTestId('track-action-Start radio').click();
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();

    const radio = page.getByTestId('now-playing-radio');
    await expect(radio).toHaveAttribute('aria-pressed', 'true');

    // Expand, pick "too different" → the next /api/radio/next carries strategy=similar.
    await page.getByTestId('radio-chip-expand').click();
    const group = page.getByTestId('radio-variety');
    await expect(group).toHaveAttribute('role', 'radiogroup');
    await expect(page.getByTestId('radio-variety-balanced')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const fetch = page.waitForRequest(
      (r) => r.url().includes('/api/radio/next') && r.url().includes('strategy=similar'),
    );
    await page.getByTestId('radio-variety-too-different').click();
    await fetch;
    await expect(page.getByTestId('radio-variety-too-different')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Remembered server-side as the default for new radios.
    await expect
      .poll(async () => {
        const me = await request.get('/api/auth/me', { headers: auth });
        return ((await me.json()) as { radioStrategy?: string }).radioStrategy;
      })
      .toBe('similar');

    // Put it back so the shared user's other specs see the default.
    await page.getByTestId('radio-variety-balanced').click();
    await expect
      .poll(async () => {
        const me = await request.get('/api/auth/me', { headers: auth });
        return ((await me.json()) as { radioStrategy?: string }).radioStrategy;
      })
      .toBe('balanced');
  });
});
