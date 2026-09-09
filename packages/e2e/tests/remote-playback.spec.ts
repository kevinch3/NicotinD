import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { FIXTURE, expandGroup, openAlbumCard } from '../helpers';

/**
 * Remote playback across two real browser contexts (issue #877).
 *
 * The unit and simulation layers model Hono's Bun adapter; this spec is the
 * one place the REAL adapter, the real sockets and two real players meet. It
 * asserts what the unit tests cannot: that a frame sent after REGISTER is
 * attributed to its connection end-to-end (progress reaches the controller),
 * and that exactly one <audio> element plays at any point of the flow.
 *
 * Both contexts share the admin storageState but carry their own device id
 * (localStorage, seeded before the SPA boots). A device is available as an
 * output by default, but Chromium still needs one user gesture on a tab
 * before it may play without a click — `activate()` gives a fresh tab one.
 *
 * The server keeps one session per user across the tests in this file, so
 * every test seeds its own device ids and closes its output tab at the end:
 * `pagehide` releases the session at once, which is what the next test's
 * first play relies on (a claim never wins against a live output).
 */

async function seedDevice(
  context: BrowserContext,
  opts: { id: string; name: string; available?: boolean },
): Promise<void> {
  // Init scripts run on EVERY navigation, and the shared admin storageState
  // already carries the device id the setup run minted. Seed on the first
  // load only (marker key), overriding that id, so the app's own writes (the
  // Settings toggle) survive a later page load.
  await context.addInitScript((o) => {
    const marker = `e2e_seeded_${o.id}`;
    if (localStorage.getItem(marker)) return;
    localStorage.setItem(marker, '1');
    // Since #882 the device id is `<profile>:<tab>` — this seeds the PROFILE
    // half, so selectors match on the prefix, not the whole id.
    localStorage.setItem('nicotind_device_id', o.id);
    localStorage.setItem('nicotind_device_name', o.name);
    if (o.available !== undefined) {
      localStorage.setItem('nicotind_remote_available', String(o.available));
    }
  }, opts);
}

/** Give a fresh tab the one gesture Chromium's autoplay policy wants, the way
 *  a user does: an in-app click (the Library link), no Settings involved. */
async function activate(page: Page): Promise<void> {
  if (!page.url().startsWith('http')) await page.goto('/library');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page).toHaveURL(/\/settings/);
}

function switcherIcon(page: Page) {
  return page.getByTestId('device-switcher-toggle').first();
}

/** The player's play/pause button reports what it believes with `data-playing`. */
function playPauseState(page: Page): Promise<string | null> {
  return page.getByTestId('player-playpause').first().getAttribute('data-playing');
}

/** `true` when an <audio> element on the page is advancing. */
function audioPlaying(p: Page): Promise<boolean> {
  return p
    .evaluate(() =>
      Array.from(document.querySelectorAll('audio')).some(
        (a) => !a.paused && (a.readyState >= 2 || a.currentTime > 0),
      ),
    )
    .catch(() => false);
}

function audioPaused(p: Page): Promise<boolean> {
  return p
    .evaluate(() => Array.from(document.querySelectorAll('audio')).every((a) => a.paused))
    .catch(() => true);
}

function playerTitle(p: Page): Promise<string> {
  return p
    .getByTestId('player-title')
    .first()
    .textContent()
    .then((t) => t?.trim() ?? '');
}

/** Every playback-socket frame a page sends or receives, kept for the report
 *  (`frames.txt`) so a failure here is diagnosable from CI output alone. */
class FrameLog {
  readonly lines: string[] = [];
  /** Positions the controller was told about by STATE_SYNC frames. */
  readonly positions: number[] = [];
  private readonly t0 = Date.now();

  tap(page: Page, who: string): void {
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/api/ws/playback')) return;
      this.push(who, 'OPEN', '');
      ws.on('framesent', (f) => this.push(who, '→', String(f.payload)));
      ws.on('framereceived', (f) => this.push(who, '←', String(f.payload)));
      ws.on('close', () => this.push(who, 'CLOSE', ''));
    });
  }

  private push(who: string, dir: string, payload: string): void {
    const t = ((Date.now() - this.t0) / 1000).toFixed(1).padStart(6);
    this.lines.push(`${t} ${who} ${dir} ${payload.slice(0, 300)}`);
    if (dir !== '←') return;
    try {
      const m = JSON.parse(payload) as { type: string; payload: { state?: { position?: number } } };
      if (m.type === 'STATE_SYNC' && typeof m.payload.state?.position === 'number') {
        this.positions.push(m.payload.state.position);
      }
    } catch {
      /* not JSON */
    }
  }
}

/** Flip *Let my other devices play music on this device* the way a user does: in-app
 *  navigation, so the playback socket stays up (a `goto` would reload the SPA
 *  and turn the opt-out into a socket drop, which the server rightly holds for
 *  its reconnect grace instead of releasing). */
async function setRemoteToggle(page: Page, on: boolean): Promise<void> {
  if (page.url().startsWith('http')) {
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page).toHaveURL(/\/settings/);
  } else {
    await page.goto('/settings');
  }
  await expandGroup(page, 'settings-playback');
  const toggle = page.getByTestId('remote-toggle');
  await expect(toggle).toBeVisible();
  if (((await toggle.getAttribute('aria-checked')) === 'true') !== on) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}

async function openSwitcher(page: Page) {
  await page.getByTestId('device-switcher-toggle').first().click();
  const panel = page.getByTestId('device-switcher-panel').first();
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('remote playback', () => {
  test.setTimeout(120_000);

  /** Two contexts sharing the admin login, each its own device. */
  async function twoDevices(
    browser: import('@playwright/test').Browser,
    base: Page,
    ids: { a: string; b: string },
    seedB: { available?: boolean } = {},
  ) {
    const storageState = await base.context().storageState();
    const ctxA = await browser.newContext({ storageState });
    await seedDevice(ctxA, { id: ids.a, name: `Dev ${ids.a}` });
    const ctxB = await browser.newContext({ storageState });
    await seedDevice(ctxB, { id: ids.b, name: `Dev ${ids.b}`, ...seedB });
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const frames = new FrameLog();
    frames.tap(a, 'A');
    frames.tap(b, 'B');
    const close = async () => {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
      await ctxA.close().catch(() => {});
      await ctxB.close().catch(() => {});
    };
    return { a, b, frames, close };
  }

  async function saveFrames(testInfo: import('@playwright/test').TestInfo, frames: FrameLog) {
    // On disk under the test's output dir (kept on failure), not only in the
    // report body — the list reporter does not persist body attachments.
    const framesPath = testInfo.outputPath('frames.txt');
    writeFileSync(framesPath, frames.lines.join('\n'));
    await testInfo.attach('frames.txt', { path: framesPath, contentType: 'text/plain' });
  }

  async function playAlbum(page: Page): Promise<void> {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await expect.poll(() => audioPlaying(page), { timeout: 15_000 }).toBe(true);
  }

  test('on by default: the first device to play is the output, a pick elsewhere plays there, a closed tab frees it', async ({
    page,
    browser,
  }, testInfo) => {
    const { a, b, frames, close } = await twoDevices(browser, page, {
      a: 'e2e-rp1-a',
      b: 'e2e-rp1-b',
    });
    try {
      // A plays with nobody having touched Settings: it claims the output.
      await playAlbum(a);
      const first = await playerTitle(a);

      // B, fresh, sees the session: the strip names A and the bar mirrors A's track.
      await b.goto('/library');
      const strip = b.getByTestId('playing-elsewhere').first();
      await expect(strip).toBeVisible({ timeout: 10_000 });
      await expect(strip).toContainText('Dev e2e-rp1-a');
      await expect(strip).toHaveAttribute('data-controllable', 'true');
      await expect.poll(() => playerTitle(b), { timeout: 10_000 }).toBe(first);
      expect(await audioPaused(b)).toBe(true);

      // A pick on B plays on A — only the picker moves audio.
      await openAlbumCard(b, FIXTURE.album.title);
      await b.getByTestId('track-row-title').filter({ hasText: 'Sixth Sense' }).click();
      await expect.poll(() => playerTitle(a), { timeout: 10_000 }).toContain('Sixth Sense');
      await expect.poll(() => audioPlaying(a), { timeout: 10_000 }).toBe(true);
      expect(await audioPaused(b)).toBe(true);
      expect(await audioPlaying(b)).toBe(false);

      // A's tab closes: the session is released at once, not after the grace.
      await a.close();
      await expect(strip).toBeHidden({ timeout: 5_000 });

      // B's play now claims the output and makes sound here.
      await b.getByTestId('player-playpause').first().click();
      await expect.poll(() => audioPlaying(b), { timeout: 10_000 }).toBe(true);
      await expect(strip).toBeHidden();
    } finally {
      await saveFrames(testInfo, frames);
      await close();
    }
  });

  test('the picker moves audio; the controller drives it and stays truthful', async ({
    page,
    browser,
  }, testInfo) => {
    const { a: controller, b: receiver, frames, close } = await twoDevices(browser, page, {
      a: 'e2e-rp2-c',
      b: 'e2e-rp2-r',
    });
    const { positions } = frames;
    try {
      await playAlbum(controller);
      // The receiver never opens Settings; one in-app click is its gesture.
      await activate(receiver);

      // Cast.
      await openSwitcher(controller);
      const option = controller
        .locator('[data-testid="device-option"][data-device-id^="e2e-rp2-r:"]')
        .first();
      await expect(option).toBeVisible({ timeout: 10_000 });
      await option.click();

      await expect.poll(() => audioPlaying(receiver), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => audioPaused(controller), { timeout: 5_000 }).toBe(true);
      await expect(controller.getByTestId('playing-elsewhere').first()).toContainText('Dev e2e-rp2-r');

      // The receiver's progress must reach the controller: this is the
      // connection-identity bug (#877) end-to-end, through the real adapter.
      await expect
        .poll(() => positions.some((p) => p > 0.5), { timeout: 10_000, intervals: [500] })
        .toBe(true);

      // Remote pause round-trip; the controller stays silent throughout.
      await controller.getByTestId('player-playpause').click();
      await expect.poll(() => audioPaused(receiver), { timeout: 6_000 }).toBe(true);
      expect(await audioPaused(controller)).toBe(true);
      await controller.getByTestId('player-playpause').click();
      await expect.poll(() => audioPlaying(receiver), { timeout: 6_000 }).toBe(true);

      // The receiver pauses ITSELF: the controller's button must flip, so its
      // next press is PLAY and not a second PAUSE.
      await receiver.getByTestId('player-playpause').first().click();
      await expect.poll(() => audioPaused(receiver), { timeout: 6_000 }).toBe(true);
      await expect.poll(() => playPauseState(controller), { timeout: 6_000 }).toBe('false');
      await controller.getByTestId('player-playpause').click();
      await expect.poll(() => audioPlaying(receiver), { timeout: 6_000 }).toBe(true);
      await expect.poll(() => playPauseState(controller), { timeout: 6_000 }).toBe('true');

      // Take it back: audio returns to the controller, the receiver goes quiet.
      await openSwitcher(controller);
      await controller.getByTestId('device-option-self').first().click();
      await expect.poll(() => audioPlaying(controller), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => audioPaused(receiver), { timeout: 5_000 }).toBe(true);
      await expect(controller.getByTestId('playing-elsewhere').first()).toBeHidden();
    } finally {
      await saveFrames(testInfo, frames);
      await close();
    }
  });

  test('opting out: the first to play, still the output; hidden from the picker; a play elsewhere claims', async ({
    page,
    browser,
  }, testInfo) => {
    const { a, b, frames, close } = await twoDevices(browser, page, {
      a: 'e2e-rp3-a',
      b: 'e2e-rp3-b',
    });
    try {
      await activate(a);
      // B turns the toggle off through the real Settings switch.
      await setRemoteToggle(b, false);
      await expect(b.getByTestId('remote-unavailable-note')).toBeVisible();

      // B plays first, with no session anywhere: it still claims the output.
      await b.goto('/library');
      await openAlbumCard(b, FIXTURE.album.title);
      await b.getByTestId('track-row-title').filter({ hasText: 'Sixth Sense' }).click();
      await expect.poll(() => audioPlaying(b), { timeout: 15_000 }).toBe(true);

      // A sees the session but cannot drive it: the strip says so, and the
      // picker lists B without offering it.
      await a.goto('/library');
      const strip = a.getByTestId('playing-elsewhere').first();
      await expect(strip).toBeVisible({ timeout: 10_000 });
      await expect(strip).toHaveAttribute('data-controllable', 'false');
      await expect(a.getByTestId('playing-elsewhere-uncontrollable').first()).toBeVisible();
      const panel = await openSwitcher(a);
      await expect(
        panel.locator('[data-testid="device-option-unavailable"][data-device-id^="e2e-rp3-b:"]'),
      ).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByTestId('device-option')).toHaveCount(0);
      await switcherIcon(a).click();

      // A play on A cannot reach B, so it claims: audio comes here, B stops —
      // still one audible device, the opted-out one included.
      await a.getByTestId('player-playpause').first().click();
      await expect.poll(() => audioPlaying(a), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => audioPaused(b), { timeout: 5_000 }).toBe(true);
      await expect(strip).toBeHidden({ timeout: 5_000 });
      await expect(b.getByTestId('playing-elsewhere').first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await saveFrames(testInfo, frames);
      await close();
    }
  });
});
