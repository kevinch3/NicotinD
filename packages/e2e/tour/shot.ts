/**
 * The tour's camera: a `shot` fixture that records WHERE in its video each shot
 * should be cut, so `cut-tour.ts` can assemble the final edit without anyone
 * scrubbing a timeline by hand.
 *
 * A shot's timeline is a list of segments in seconds from the moment its page
 * (and so its video) was created. `begin()` sets the in-point once the page has
 * settled; `fast()` plays whatever it wraps — a download, a scan — at a multiple
 * of real time; `end()` sets the out-point. Each test is one shot and one video.
 */
import { test as base, type Locator } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERLAY_SCRIPT } from './overlay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOTS_DIR = resolve(HERE, '../tour-output/shots');

export interface Segment {
  start: number;
  end: number;
  speed: number;
}

export interface ShotRecord {
  order: number;
  name: string;
  /** Directory Playwright writes this test's `video.webm` into. */
  videoDir: string;
  segments: Segment[];
}

export interface Shot {
  begin(): void;
  end(): void;
  /** Run `action` and play it back `speed`× faster in the edit. */
  fast<T>(speed: number, action: () => Promise<T>): Promise<T>;
  /**
   * `bottom` (default) sits above the player bar; `top` below the app header;
   * `header` over the header itself, for full-screen views like Now Playing.
   */
  caption(text: string | null, position?: 'bottom' | 'top' | 'header'): Promise<void>;
  /** Move the visible cursor to the middle of `target`, the way a hand would. */
  glide(target: Locator | { x: number; y: number }, steps?: number): Promise<void>;
  /** Glide, pause the way a person does before committing, then click. */
  click(target: Locator): Promise<void>;
  hold(ms: number): Promise<void>;
}

export const test = base.extend<{ shot: Shot }>({
  page: async ({ page }, use) => {
    await page.addInitScript(OVERLAY_SCRIPT);
    await use(page);
  },
  shot: async ({ page }, use, testInfo) => {
    const t0 = Date.now();
    const now = () => (Date.now() - t0) / 1000;
    const segments: Segment[] = [];
    let open: number | null = null;
    let cursor = { x: 640, y: 360 };

    const close = (speed = 1) => {
      if (open === null) return;
      segments.push({ start: open, end: now(), speed });
      open = null;
    };

    const glide = async (target: Locator | { x: number; y: number }, steps = 28) => {
      let to: { x: number; y: number };
      if ('boundingBox' in target) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        if (!box) throw new Error('glide: target has no box');
        to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      } else to = target;
      await page.mouse.move(to.x, to.y, { steps });
      cursor = to;
    };

    const shot: Shot = {
      begin: () => {
        open = now();
      },
      end: () => close(),
      fast: async (speed, action) => {
        close();
        open = now();
        const result = await action();
        close(speed);
        open = now();
        return result;
      },
      caption: async (text, position = 'bottom') => {
        await page.evaluate(
          ([t, p]) =>
            (
              window as unknown as { __tour?: { caption(t: string | null, p: string): void } }
            ).__tour?.caption(t, p),
          [text, position] as const,
        );
      },
      glide,
      click: async (target) => {
        await glide(target);
        await page.waitForTimeout(250);
        await page.mouse.click(cursor.x, cursor.y);
      },
      hold: (ms) => page.waitForTimeout(ms),
    };

    await page.mouse.move(cursor.x, cursor.y);
    await use(shot);
    close();

    const order = Number(/^(\d+)/.exec(testInfo.title)?.[1] ?? 0);
    const record: ShotRecord = {
      order,
      name: testInfo.title,
      videoDir: testInfo.outputDir,
      segments,
    };
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(
      resolve(SHOTS_DIR, `${String(order).padStart(2, '0')}.json`),
      JSON.stringify(record, null, 2),
    );
  },
});

export { expect } from '@playwright/test';

/** The tour admin's bearer token, from the storage state `tour.setup.ts` saved. */
export function tourToken(): string {
  const state = JSON.parse(readFileSync(resolve(HERE, '../.auth/tour.json'), 'utf8')) as {
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };
  const entry = state.origins
    .flatMap((o) => o.localStorage)
    .find((e) => e.name === 'nicotind_token');
  if (!entry) throw new Error('tour.setup.ts saved no token');
  return entry.value;
}
