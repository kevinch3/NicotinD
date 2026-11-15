/**
 * Swipe-to-skip on the real APK reaches the phone's vibrator (#1376).
 *
 * Chromium can only record `navigator.vibrate`; the APK calls
 * `@capacitor/haptics` → Android's Vibrator, which no browser models. The
 * emulator's vibrator logs every request with the calling package, so "one
 * light tick per committed skip, none for a cancelled swipe" is assertable
 * without a person holding a phone. What it cannot judge is how the tick
 * FEELS — that stays a manual check (docs/mobile-app.md, "Haptics").
 */
import { test, expect, openNowPlaying } from '../phone/fixtures.js';

/** `SKIP_THRESHOLD_PX` is 80 (lib/swipe-to-skip.ts): one well past it, one well short. */
const COMMIT_DX = -260;
const CANCEL_DX = -15;

test.describe('haptics on the Android vibrator (#1376)', () => {
  test.beforeEach(async ({ page, token }) => {
    await openNowPlaying(page, token);
  });

  test('a committed swipe on the cover skips and ticks once', async ({ page, swipe, haptics }) => {
    const title = page.getByTestId('player-title').first();
    const before = await title.innerText();
    const mark = await haptics.mark();

    await swipe(page.getByTestId('now-playing-cover-art'), COMMIT_DX);

    await expect(title).not.toHaveText(before);
    await expect.poll(async () => (await haptics.since(mark)).length).toBe(1);
    const [tick] = await haptics.since(mark);
    // `commit` maps to a LIGHT impact (lib/haptics.ts HAPTIC_MAP): a touch-usage
    // vibration, not a notification-strength buzz.
    expect(tick.usage).toBe('TOUCH');
  });

  test('a cancelled swipe on the cover neither skips nor ticks', async ({
    page,
    swipe,
    haptics,
  }) => {
    const title = page.getByTestId('player-title').first();
    const before = await title.innerText();
    const mark = await haptics.mark();

    await swipe(page.getByTestId('now-playing-cover-art'), CANCEL_DX, 250);

    // Give a late tick the same window a committed one gets before calling it absent.
    await page.waitForTimeout(1500);
    await expect(title).toHaveText(before);
    expect(await haptics.since(mark)).toEqual([]);
  });
});
