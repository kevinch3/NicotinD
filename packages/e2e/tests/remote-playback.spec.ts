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
 * (localStorage, seeded before the SPA boots). The target's Settings toggle
 * click doubles as the user activation Chromium needs for gesture-less play.
 */

const CONTROLLER_ID = 'e2e-rp-controller';
const RECEIVER_ID = 'e2e-rp-receiver';

async function seedDevice(
  context: BrowserContext,
  opts: { id: string; name: string; remoteEnabled: boolean },
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
    localStorage.setItem('nicotind_remote_enabled', String(o.remoteEnabled));
  }, opts);
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

/** Flip *Make available* the way a user does on a running receiver: in-app
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

  test('cast, progress, opt-out and re-cast keep exactly one device playing', async ({
    page: controller,
    browser,
  }, testInfo) => {
    await seedDevice(controller.context(), {
      id: CONTROLLER_ID,
      name: 'E2E Controller',
      remoteEnabled: true,
    });
    const frames = new FrameLog();
    frames.tap(controller, 'C');
    const { positions } = frames;

    const receiverContext = await browser.newContext({
      storageState: await controller.context().storageState(),
    });
    await seedDevice(receiverContext, {
      id: RECEIVER_ID,
      name: 'E2E Receiver',
      remoteEnabled: false,
    });
    const receiver = await receiverContext.newPage();
    frames.tap(receiver, 'R');

    try {
      // Controller plays locally.
      await controller.goto('/library');
      await openAlbumCard(controller, FIXTURE.album.title);
      await controller.getByTestId('play-album').click();
      await expect.poll(() => audioPlaying(controller), { timeout: 15_000 }).toBe(true);

      // Receiver opts in through the real Settings toggle.
      await setRemoteToggle(receiver, true);

      // Cast.
      await openSwitcher(controller);
      const option = controller
        .locator(`[data-testid="device-option"][data-device-id^="${RECEIVER_ID}:"]`)
        .first();
      await expect(option).toBeVisible({ timeout: 10_000 });
      await option.click();

      await expect.poll(() => audioPlaying(receiver), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => audioPaused(controller), { timeout: 5_000 }).toBe(true);

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

      // The receiver opts out: the controller is released, shows no phantom
      // device, and does not start playing on its own.
      await setRemoteToggle(receiver, false);
      await expect
        .poll(
          () =>
            controller
              .getByTestId('device-switcher-toggle')
              .first()
              .evaluate((el) => el.className.includes('text-status-done')),
          { timeout: 10_000 },
        )
        .toBe(false);
      const panel = await openSwitcher(controller);
      await expect(panel.getByText('No other devices online')).toBeVisible();
      await expect(controller.getByTestId('device-now-playing')).toHaveCount(0);
      await controller.getByTestId('device-switcher-toggle').first().click();
      expect(await audioPaused(controller)).toBe(true);

      // The controller moves on to another track while the receiver is out,
      // the receiver opts back in, and a fresh cast plays THAT track there.
      await controller.goto('/library');
      await openAlbumCard(controller, FIXTURE.album.title);
      await controller.getByTestId('track-row-title').filter({ hasText: 'Sixth Sense' }).click();
      await expect.poll(() => audioPlaying(controller), { timeout: 15_000 }).toBe(true);
      const chosen = await playerTitle(controller);
      expect(chosen).toContain('Sixth Sense');

      await setRemoteToggle(receiver, true);
      await openSwitcher(controller);
      await expect(option).toBeVisible({ timeout: 10_000 });
      await option.click();
      await expect.poll(() => audioPlaying(receiver), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => audioPaused(controller), { timeout: 5_000 }).toBe(true);
      await expect.poll(() => playerTitle(receiver), { timeout: 10_000 }).toBe(chosen);
    } finally {
      // On disk under the test's output dir (kept on failure), not only in the
      // report body — the list reporter does not persist body attachments.
      const framesPath = testInfo.outputPath('frames.txt');
      writeFileSync(framesPath, frames.lines.join('\n'));
      await testInfo.attach('frames.txt', { path: framesPath, contentType: 'text/plain' });
      await receiver.close().catch(() => {});
      await receiverContext.close().catch(() => {});
    }
  });
});
