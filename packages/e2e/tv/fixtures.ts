/**
 * Fixtures for the Android TV emulator lane. Specs in `tests-tv/` import `test`
 * and `expect` from HERE, never from `@playwright/test` — the `page` fixture is
 * overridden to return the emulator's WebView page.
 *
 * See docs/e2e-tv-emulator.md for why this lane exists (short version: an
 * Android WebView has spatial navigation and desktop Chrome does not, so the
 * Chromium suite structurally cannot tell "focus correctly moved" apart from
 * "focus never could have moved").
 */
import { _android, test as base, expect } from '@playwright/test';
import type { AndroidDevice, Page } from '@playwright/test';
import { targetFor } from '../android/targets.js';
import { APP_ORIGIN, apiOrigin, goto, seedAuth } from '../android/session.js';

export { expect, APP_ORIGIN, goto };

const TV = targetFor('tv');
const APP_ID = TV.appId;
/** The API, reached from the device through `adb reverse`. */
export const API_ORIGIN = apiOrigin(TV.port);

export const TV_ADMIN = { username: 'tv-admin', password: 'tv-password-123' } as const;

export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'CENTER' | 'BACK';

interface TvFixtures {
  device: AndroidDevice;
  page: Page;
  dpad: (dir: Direction, times?: number) => Promise<void>;
  focusId: () => Promise<string>;
}

export const test = base.extend<TvFixtures>({
  device: async ({}, use) => {
    const devices = await _android.devices();
    const serial = process.env.E2E_ANDROID_SERIAL;
    const device = serial ? devices.find((d) => d.serial() === serial) : devices[0];
    if (!device) {
      throw new Error(
        '[e2e:tv] no adb device. Run `bun run e2e:tv` — it boots the emulator; ' +
          'invoking playwright directly skips preflight.',
      );
    }
    await use(device);
    await device.close();
  },

  page: async ({ device }, use) => {
    const wv = device.webViews().find((w) => w.pkg() === APP_ID);
    if (!wv) throw new Error(`[e2e:tv] ${APP_ID} exposes no WebView — did it crash on launch?`);
    const page = await wv.page();
    await seedAuth(page, API_ORIGIN, TV_ADMIN);
    await use(page);
  },

  /**
   * Hardware key events through the Android input pipeline.
   *
   * Measured: synthetic (`page.keyboard.press`) and hardware keys behave
   * IDENTICALLY in the WebView, including for spatial navigation. This uses
   * hardware keys for fidelity to what a remote actually does, not because
   * synthetic ones are broken — don't "simplify" it away, and equally don't
   * assume synthetic keys are inadequate, without re-measuring.
   */
  dpad: async ({ device }, use) => {
    await use(async (dir, times = 1) => {
      for (let i = 0; i < times; i++) {
        await device.shell(`input keyevent KEYCODE_${dir === 'BACK' ? 'BACK' : `DPAD_${dir}`}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    });
  },

  /**
   * Stable identity for the focused element: testid plus its index among
   * same-testid siblings.
   *
   * The index is load-bearing. Every track row's title shares one testid, so a
   * bare testid makes a walk down a list look stationary — exactly the reading
   * that made issue #436 ambiguous until the index was added.
   */
  focusId: async ({ page }, use) => {
    await use(() =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return 'none';
        const id = el.dataset?.testid ?? el.getAttribute('aria-label') ?? el.tagName.toLowerCase();
        const peers = [...document.querySelectorAll(`[data-testid="${el.dataset?.testid ?? ''}"]`)];
        const idx = peers.indexOf(el);
        return idx > 0 ? `${id}#${idx}` : id;
      }),
    );
  },
});

/**
 * Start playback and land on the TV player route.
 *
 * There is no mini-player on TV any more (docs/tv-ux.md) — the player is a
 * route, and the shell navigates to it when something starts playing. So this
 * ends on `/player` rather than on a bar at the bottom of the previous screen.
 */
export async function startPlayback(page: Page): Promise<void> {
  await goto(page, '/library');
  const card = page.getByTestId('tv-album-card').first();
  await card.waitFor({ state: 'visible' });
  await card.click();
  await page.getByTestId('tv-album-play').click();
  await expect(page.getByTestId('tv-player-title')).toBeVisible();
}
