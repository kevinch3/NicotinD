/**
 * Fixtures for the Android phone emulator lane (`bun run e2e:phone`). Specs in
 * `tests-phone/` import `test` and `expect` from HERE, never from
 * `@playwright/test` — the `page` fixture is the emulator's WebView page.
 *
 * What this lane has that Chromium cannot: touches through Android's real input
 * pipeline, and a vibrator that records every vibration an app requests. See
 * docs/e2e-tv-emulator.md, "The phone lane".
 */
import { _android, test as base, expect } from '@playwright/test';
import type { AndroidDevice, Locator, Page } from '@playwright/test';
import {
  parseVibrations,
  targetFor,
  toDevicePoint,
  vibrationsSince,
  webViewOrigin,
} from '../android/targets.js';
import type { Vibration } from '../android/targets.js';
import { APP_ORIGIN, apiOrigin, goto, seedAuth } from '../android/session.js';

export { expect, APP_ORIGIN, goto };

const PHONE = targetFor('phone');
export const API_ORIGIN = apiOrigin(PHONE.port);
export const PHONE_ADMIN = { username: 'phone-admin', password: 'phone-password-123' } as const;

export interface Haptics {
  /** The device clock, to pass to `since`. */
  mark: () => Promise<string>;
  /** The app's vibrations strictly after `mark`. */
  since: (mark: string) => Promise<Vibration[]>;
}

interface PhoneFixtures {
  device: AndroidDevice;
  token: string;
  page: Page;
  /**
   * A horizontal swipe of `dx` CSS pixels across the element's centre, through
   * `adb shell input` — a real touch, not a CDP dispatch.
   */
  swipe: (target: Locator, dx: number, ms?: number) => Promise<void>;
  haptics: Haptics;
}

export const test = base.extend<PhoneFixtures>({
  device: async ({}, use) => {
    const devices = await _android.devices();
    const serial = process.env.E2E_ANDROID_SERIAL;
    const device = serial ? devices.find((d) => d.serial() === serial) : devices[0];
    if (!device) {
      throw new Error(
        '[e2e:phone] no adb device. Run `bun run e2e:phone` — it boots the emulator; ' +
          'invoking playwright directly skips preflight.',
      );
    }
    await use(device);
    await device.close();
  },

  token: async ({ page }, use) => {
    await use(await page.evaluate(() => localStorage.getItem('nicotind_token') ?? ''));
  },

  page: async ({ device }, use) => {
    const wv = device.webViews().find((w) => w.pkg() === PHONE.appId);
    if (!wv)
      throw new Error(`[e2e:phone] ${PHONE.appId} exposes no WebView — did it crash on launch?`);
    const page = await wv.page();
    await seedAuth(page, API_ORIGIN, PHONE_ADMIN);
    await use(page);
  },

  swipe: async ({ device, page }, use) => {
    await use(async (target, dx, ms = 200) => {
      const box = await target.boundingBox();
      if (!box) throw new Error('[e2e:phone] swipe target has no box — is it rendered?');
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      // Read each time: the WebView's origin moves with the system bars.
      await device.shell('uiautomator dump /sdcard/nicotind-ui.xml');
      const origin = webViewOrigin((await device.shell('cat /sdcard/nicotind-ui.xml')).toString());
      const cy = box.y + box.height / 2;
      const cx = box.x + box.width / 2;
      const from = toDevicePoint({ x: cx - dx / 2, y: cy }, dpr, origin);
      const to = toDevicePoint({ x: cx + dx / 2, y: cy }, dpr, origin);
      await device.shell(`input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${ms}`);
    });
  },

  haptics: async ({ device }, use) => {
    await use({
      mark: async () => (await device.shell("date +'%m-%d %H:%M:%S.%3N'")).toString().trim(),
      since: async (mark) =>
        vibrationsSince(
          parseVibrations((await device.shell('dumpsys vibrator_manager')).toString(), PHONE.appId),
          mark,
        ),
    });
  },
});

/** Play the first album and open Now Playing, ending with its cover settled. */
export async function openNowPlaying(page: Page, token: string): Promise<void> {
  // The library scans on boot; poll the API rather than racing the first grid render.
  let albumId = '';
  await expect
    .poll(
      async () => {
        const res = await fetch(`${API_ORIGIN}/api/library/albums?size=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        albumId = res.ok ? (((await res.json()) as { id: string }[])[0]?.id ?? '') : '';
        return albumId;
      },
      { timeout: 60_000 },
    )
    .not.toBe('');
  await goto(page, `/library/albums/${albumId}`);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  const cover = page.getByTestId('now-playing-cover-art');
  await expect(cover).toBeInViewport();
  // The sheet slides up on a transform: swipe only once the cover has stopped.
  let last = '';
  await expect
    .poll(async () => {
      const b = await cover.boundingBox();
      const now = b ? `${Math.round(b.x)},${Math.round(b.y)}` : '';
      const settled = now !== '' && now === last;
      last = now;
      return settled;
    })
    .toBe(true);
}
