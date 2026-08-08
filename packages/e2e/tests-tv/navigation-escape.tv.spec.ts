/**
 * Can focus get OUT of a content region and reach the player chrome?
 *
 * This is issue #436 generalized. `TvNavGroupDirective` clamps at a group edge
 * and `preventDefault()`s unconditionally (so an edge press can't leak into the
 * global ArrowLeft/Right seek shortcut). On desktop that is invisible — focus
 * wasn't going anywhere regardless. On a TV it suppresses the WebView's
 * spatial-navigation escape, trapping focus inside any bottom-most nav group.
 *
 * The bug is a *pattern*, not a one-off: it recurs on any surface whose content
 * ends in a nav group. Hence one test per surface rather than one for albums.
 */
import { test, expect, goto, startPlayback } from '../tv/fixtures.js';
import type { Page } from '@playwright/test';

test.describe('D-pad escape to the player', () => {
  test.beforeEach(async ({ page }) => {
    await startPlayback(page);
  });

  /** Press DOWN until focus reaches the player, or we run out of patience. */
  async function pressDownUntilPlayer(
    dpad: (d: 'DOWN', n?: number) => Promise<void>,
    focusId: () => Promise<string>,
    max = 25,
  ): Promise<{ reached: boolean; trail: string[] }> {
    const trail: string[] = [await focusId()];
    for (let i = 0; i < max; i++) {
      await dpad('DOWN');
      const id = await focusId();
      trail.push(id);
      if (id.startsWith('player-')) return { reached: true, trail };
      // Focus stopped moving: clamped at an edge with nowhere to go.
      if (trail.length >= 4 && new Set(trail.slice(-4)).size === 1) break;
    }
    return { reached: false, trail };
  }

  /**
   * Blocked by #436 today. `test.fail()` keeps the suite green while the bug is
   * open AND fails loudly the moment #436 is fixed without updating this file —
   * so the finding stays executable instead of rotting into a comment.
   */
  test.fail(
    true,
    'issue #436 — TvNavGroupDirective clamps + preventDefaults, suppressing spatial-nav escape',
  );

  interface Surface {
    name: string;
    /** Navigate to the surface under test, leaving a track list on screen. */
    open: (page: Page) => Promise<void>;
  }

  const SURFACES: Surface[] = [
    {
      name: 'album detail',
      open: async (page) => {
        await goto(page, '/library');
        await page.getByTestId('album-card').first().click();
      },
    },
    {
      name: 'library Songs',
      open: async (page) => goto(page, '/library?tab=songs'),
    },
    {
      name: 'artist detail',
      open: async (page) => {
        await goto(page, '/library?tab=artists');
        await page.getByTestId('artist-card').first().click();
      },
    },
  ];

  for (const surface of SURFACES) {
    test(`focus escapes ${surface.name} and reaches the player`, async ({
      page,
      dpad,
      focusId,
    }) => {
      await surface.open(page);

      // Enter the content region the way a viewer would.
      const firstRow = page.getByTestId('track-row-title').first();
      await firstRow.waitFor({ state: 'visible' });
      await firstRow.focus();

      const { reached, trail } = await pressDownUntilPlayer(dpad, focusId);
      expect(reached, `focus never left the content region. Trail: ${trail.join(' → ')}`).toBe(
        true,
      );
    });
  }
});
