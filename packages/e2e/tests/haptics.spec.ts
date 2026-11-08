import { test, expect, expandGroup, type Page } from '../helpers';

/**
 * The haptic vocabulary's web fallback (#1659), on an emulated touch phone:
 * `navigator.vibrate` is replaced by a recorder before the app boots, so the
 * spec reads exactly which patterns the app asked for. Native shells go through
 * `@capacitor/haptics` instead and are a real-device gate (docs/mobile-app.md).
 */
test.describe('haptics on a touch phone (#1659)', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __vibrations: unknown[] };
      w.__vibrations = [];
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: (pattern: unknown) => {
          w.__vibrations.push(pattern);
          return true;
        },
      });
    });
  });

  const vibrations = (page: Page) =>
    page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations);

  /** Hold a resting song tile past the 450 ms threshold, the way mosaic-home.spec does. */
  async function holdATile(page: Page): Promise<void> {
    await page.goto('/');
    const tiles = page.locator('[data-testid="mosaic-tile"][data-tile-kind="song"]');
    await expect(tiles.first()).toBeVisible({ timeout: 10_000 });
    const target = await tiles.evaluateAll((els) => {
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (
          r.x < 0 ||
          r.y < 0 ||
          r.right > window.innerWidth ||
          r.bottom > window.innerHeight - 140
        )
          continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (document.elementFromPoint(cx, cy)?.closest('[data-testid="mosaic-tile"]') === el)
          return { x: cx, y: cy };
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x, target!.y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByTestId('entity-menu')).toBeVisible({ timeout: 10_000 });
  }

  test('Reduced is the default and a tile hold vibrates the `hold` pattern', async ({ page }) => {
    await page.goto('/settings');
    await expandGroup(page, 'settings-playback');
    await expect(page.getByTestId('settings-haptics')).toBeVisible();
    await expect(page.getByTestId('settings-haptics-reduced')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await holdATile(page);
    expect(await vibrations(page)).toEqual([25]);
  });

  test('Off silences the same hold', async ({ page }) => {
    await page.goto('/settings');
    await expandGroup(page, 'settings-playback');
    await page.getByTestId('settings-haptics-off').click();
    await expect(page.getByTestId('settings-haptics-off')).toHaveAttribute('aria-pressed', 'true');

    await holdATile(page);
    expect(await vibrations(page)).toEqual([]);
  });
});

test.describe('haptics on a desktop browser', () => {
  test('offers no haptics setting where nothing can be felt', async ({ page }) => {
    await page.goto('/settings');
    await expandGroup(page, 'settings-playback');
    await expect(page.getByTestId('auto-preserve-off')).toBeVisible();
    await expect(page.getByTestId('settings-haptics')).toHaveCount(0);
  });
});
