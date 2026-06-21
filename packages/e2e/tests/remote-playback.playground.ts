import { test, expect } from '../playground/fixtures';
import { appeared } from '../playground/screens-ui';
import type { BrowserContext, Page } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * Remote-playback (device control) feedback flow — the "cast to another device"
 * feature: a controller tab steers playback on a second, remote-enabled tab over
 * the /api/ws/playback WebSocket (per-user PlaybackStateManager).
 *
 * Unlike the other playground flows this one is TWO browser contexts (controller
 * + target speaker) sharing the same account but with distinct device ids, and
 * it DOES mutate ephemeral playback-session state. That state is per-session and
 * self-resets: when the target disconnects at teardown the server unregisters it
 * and clears the active device, so nothing persists. Still records rather than
 * asserts — a dead WS / missing fixture yields a degraded observation, never red.
 *
 * Covers: opt-in via Settings toggle, device discovery latency, casting, remote
 * PLAY/PAUSE command round-trip, and the Settings "connected devices" surface.
 * See docs/testing-routines.md.
 */

const CONTROLLER_ID = 'e2e-remote-controller';
const TARGET_ID = 'e2e-remote-target';
const TARGET_NAME = 'E2E Target Speaker';

/** Seed a context's device identity + remote opt-in before the SPA boots. */
async function seedDevice(
  context: BrowserContext,
  opts: { id: string; name: string; remoteEnabled: boolean },
): Promise<void> {
  await context.addInitScript((o) => {
    localStorage.setItem('nicotind_device_id', o.id);
    localStorage.setItem('nicotind_device_name', o.name);
    localStorage.setItem('nicotind_remote_enabled', String(o.remoteEnabled));
  }, opts);
}

/** True when ≥1 <audio> element is actively advancing (loaded + not paused). */
function audioPlaying(p: Page): Promise<boolean> {
  return p
    .evaluate(() =>
      Array.from(document.querySelectorAll('audio')).some(
        (a) => !a.paused && (a.readyState >= 2 || a.currentTime > 0),
      ),
    )
    .catch(() => false);
}

/** True when every <audio> element is paused (or none exist). */
function audioPaused(p: Page): Promise<boolean> {
  return p
    .evaluate(() => Array.from(document.querySelectorAll('audio')).every((a) => a.paused))
    .catch(() => true);
}

test('remote-playback-device-control', async ({ page, obs, browser }) => {
  const j = obs.journey();
  let target: Page | null = null;
  let targetContext: BrowserContext | null = null;

  try {
    // --- Controller: opt-in pre-seeded (returning caster), play a local track ---
    await seedDevice(page.context(), {
      id: CONTROLLER_ID,
      name: 'E2E Controller',
      remoteEnabled: true,
    });

    await obs.time('controller opens /library', async () => {
      await page.goto('/library');
      await page.waitForLoadState('networkidle').catch(() => {});
    });
    j.step('controller library loaded');

    const albumCard = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    if ((await albumCard.count()) === 0) {
      j.deadEnd('fixture album not present — backend has no library');
      obs.outcome('degraded', 'no fixture album to cast');
      expect(true).toBe(true);
      return;
    }

    await albumCard.first().click();
    const localStream = page
      .waitForResponse((r) => r.url().includes('/api/stream/') && [200, 206].includes(r.status()), {
        timeout: 15_000,
      })
      .catch(() => null);
    await page.getByTestId('play-album').click();
    const streamed = await localStream;
    if (!streamed) j.fallback('controller never issued a /api/stream request');
    j.step('controller plays locally');

    // --- Target: a second device opts in via the real Settings toggle ---
    // Reusing the controller's auth (token) but with its own device id; the
    // toggle click both enables remote AND grants the user-activation the target
    // needs to autoplay an incoming cast (Chrome blocks gesture-less playback).
    const state = await page.context().storageState();
    targetContext = await browser.newContext({ storageState: state });
    await seedDevice(targetContext, { id: TARGET_ID, name: TARGET_NAME, remoteEnabled: false });
    target = await targetContext.newPage();

    await target.goto('/settings');
    await target.waitForLoadState('networkidle').catch(() => {});
    const remoteToggle = target.getByTestId('remote-toggle');
    if ((await remoteToggle.count()) === 0) {
      j.deadEnd('Settings remote-toggle not found — feature not deployed here');
      obs.outcome('partial', 'controller played; remote opt-in UI absent');
      expect(true).toBe(true);
      return;
    }
    await remoteToggle.click(); // off -> on (also unlocks autoplay on the target)
    j.step('target opts in via Settings toggle');

    // --- Controller: discover the target in the device switcher ---
    await page.getByTestId('device-switcher-toggle').first().click();
    if (!(await appeared(page.getByTestId('device-switcher-panel'), 3000))) {
      j.deadEnd('device switcher panel did not open');
      obs.outcome('partial', 'cast UI did not open');
      expect(true).toBe(true);
      return;
    }

    // NB: DeviceSwitcherComponent is mounted in both app-player and
    // app-now-playing and shares the service-level switcherOpen signal, so both
    // panels open together — every device row matches twice. Scope to .first().
    const targetOption = page
      .locator(`[data-testid="device-option"][data-device-id="${TARGET_ID}"]`)
      .first();
    const discovered = await obs.time(
      'controller discovers target device',
      async () => appeared(targetOption, 10_000),
      { warnMs: 4000 },
    );
    if (!discovered) {
      j.deadEnd('target never appeared in the device list (WS discovery failed)');
      obs.record({
        kind: 'gap',
        title: 'Remote device discovery failed',
        severity: 'high',
        detail: 'Target opted in but never surfaced in the controller device switcher within 10s.',
        suggestion: 'Verify the /api/ws/playback DEVICES_SYNC broadcast reaches sibling devices.',
      });
      obs.outcome('partial', 'discovery failed');
      expect(true).toBe(true);
      return;
    }
    j.step('controller sees target device');

    // --- Cast: hand playback to the target ---
    const targetStream = target
      .waitForResponse((r) => r.url().includes('/api/stream/') && [200, 206].includes(r.status()), {
        timeout: 15_000,
      })
      .catch(() => null);
    await targetOption.click(); // selecting a device also closes the popover (by design)

    // Reopen the switcher to confirm the controller now marks the target as the
    // active host (NOW PLAYING badge lives inside the popover).
    await page.getByTestId('device-switcher-toggle').first().click();
    const showsNowPlaying = await appeared(page.getByTestId('device-now-playing'), 5000);
    if (!showsNowPlaying) j.fallback('controller did not mark the target NOW PLAYING');
    await page.getByTestId('device-switcher-toggle').first().click().catch(() => {}); // close
    j.step('controller casts to target');

    // Target should begin streaming + advancing audio.
    const targetGotStream = await targetStream;
    const playStarted = await obs.time(
      'target begins playback after cast',
      async () =>
        expect
          .poll(() => audioPlaying(target as Page), { timeout: 10_000, intervals: [250, 500] })
          .toBe(true)
          .then(() => true)
          .catch(() => false),
      { warnMs: 4000 },
    );
    if (!targetGotStream) j.fallback('target issued no /api/stream after cast');
    if (!playStarted) {
      j.deadEnd('target did not start playing after cast (autoplay blocked or command lost)');
      obs.record({
        kind: 'gap',
        title: 'Cast did not start remote playback',
        severity: 'high',
        detail: 'Target received the cast but no audio advanced — likely autoplay block or COMMAND/STATE_SYNC race.',
      });
    } else {
      j.step('target playing');
    }

    // --- Remote control: PAUSE from the controller ---
    if (playStarted) {
      await page.getByTestId('player-playpause').click();
      const paused = await obs.time(
        'remote PAUSE round-trip',
        async () =>
          expect
            .poll(() => audioPaused(target as Page), { timeout: 6000, intervals: [200, 400] })
            .toBe(true)
            .then(() => true)
            .catch(() => false),
        { warnMs: 2000 },
      );
      if (!paused) {
        j.fallback('PAUSE command did not stop the target');
        obs.record({
          kind: 'gap',
          title: 'Remote PAUSE not honored',
          severity: 'medium',
          detail: 'Controller play/pause did not pause the active remote device.',
        });
      } else {
        j.step('remote PAUSE honored');
      }
    }

    // --- Settings surface: connected devices + active host ---
    await page.goto('/settings');
    await page.waitForLoadState('networkidle').catch(() => {});
    const toggleOn = await page
      .getByTestId('remote-toggle')
      .getAttribute('aria-checked')
      .catch(() => null);
    if (toggleOn !== 'true') j.fallback('controller remote-toggle not reflected as on');
    const targetListed = await appeared(page.getByText(TARGET_NAME), 4000);
    if (!targetListed) j.fallback('target device not shown in Settings connected-devices list');
    else j.step('connected devices listed in Settings');

    obs.outcome(
      playStarted ? 'success' : 'partial',
      playStarted ? 'cast + remote control verified' : 'discovered but playback did not start',
    );
  } finally {
    // Disconnecting the target unregisters it server-side and clears the active
    // device, so the per-user session resets — nothing persists past the run.
    await target?.close().catch(() => {});
    await targetContext?.close().catch(() => {});
  }

  expect(true).toBe(true); // a playground flow records, never asserts pass/fail
});
