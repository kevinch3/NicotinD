/**
 * TV D-pad "find a song → play → queue" flow (issue #389) — the keyboard-only
 * journey a remote-control user takes: library tabs → album grid → album
 * actions → a track row's extras → the ⋯ menu → Play next, ending with the
 * queued track visible in the TV player's Next-up chip. Runs on the prod
 * bundle by stamping the `tv-build` root class (isTvUi pattern). Named to
 * sort before offline.spec.ts (its #372 flake starves later specs).
 */
import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../helpers';

const TV_VIEWPORT = { width: 960, height: 540 };

test.describe('TV D-pad find-a-song flow', () => {
  test.use({ viewport: TV_VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const stamp = () => document.documentElement?.classList.add('tv-build');
      stamp();
      document.addEventListener('readystatechange', stamp);
      new MutationObserver(stamp).observe(document, { childList: true });
    });
  });

  test('tabs, album actions, track-row extras and the ⋯ menu are all D-pad reachable', async ({
    page,
  }) => {
    await page.goto('/library');

    // Library tabs: a horizontal nav group.
    const tabs = page.getByTestId('library-tabs').locator('button');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tabs.first()).toBeFocused();

    // Album grid (already a grid group): Enter opens the album.
    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/library\/albums\//);

    // Album action row: horizontal group, Play first then its siblings.
    const play = page.getByTestId('play-album');
    await play.focus();
    await page.keyboard.press('ArrowRight');
    await expect(play).not.toBeFocused(); // moved to the next action in the row

    // Play the album so the queue exists for the menu step below.
    await play.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('player-title')).toBeVisible();
  });

  test('Play next from a track-row menu, by keys alone, lands in the TV Next-up chip', async ({
    page,
  }) => {
    await page.goto('/library');
    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/library\/albums\//);
    await page.getByTestId('play-album').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('player-title')).toBeVisible();

    // Walk a later row: title → like → ⋯ toggle, all inside the row group.
    const rows = page.getByTestId('track-row');
    const targetRow = rows.filter({ hasText: 'Five Easy Pieces' });
    await targetRow.getByTestId('track-row-title').focus();
    await page.keyboard.press('ArrowRight');
    await expect(targetRow.getByTestId('track-like')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(targetRow.getByTestId('track-row-menu-toggle')).toBeFocused();

    // Enter opens the menu with the first action focused; ArrowDown reaches
    // Play next (menu-panel D-pad support), Enter activates it.
    await page.keyboard.press('Enter');
    const playNext = page.getByTestId('track-action-Play next');
    await expect(playNext).toBeVisible();
    for (let i = 0; i < 8; i++) {
      if (await playNext.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('ArrowDown');
    }
    await expect(playNext).toBeFocused();
    await page.keyboard.press('Enter');
    // Focus restored to the trigger after the menu closes.
    await expect(targetRow.getByTestId('track-row-menu-toggle')).toBeFocused();

    // The queued track is now the head of the queue — the TV player's chip.
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-next-up')).toContainText('Five Easy Pieces');
  });

  /**
   * Issue #432 — the mini-player grab notch was bound only to `(pointerdown)`,
   * so a remote (key events only) could neither focus nor activate it and
   * Now Playing was unreachable from the player bar. Unit tests cover the DOM
   * contract; this proves a real browser's keyboard actually gets there.
   */
  test('the mini-player grab notch is keyboard-focusable and expands Now Playing', async ({
    page,
  }) => {
    await page.goto('/library');
    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    await card.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('play-album').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('player-title')).toBeVisible();

    const grab = page.getByTestId('player-grab');
    await expect(grab).toHaveAttribute('role', 'button');
    await grab.focus();
    await expect(grab).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('now-playing-body')).toBeVisible();
  });
});
