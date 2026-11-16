import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { pinFonts } from '../tests/helpers/pinned-fonts';

/**
 * One screenshot per story (#473). The list comes from the built catalog's own
 * index, so a new story is covered the day it is written and fails until its
 * baseline is committed.
 */
interface StoryEntry {
  id: string;
  title: string;
  name: string;
  type: string;
}

const index = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../web/storybook-static/index.json'), 'utf8'),
) as { entries: Record<string, StoryEntry> };
const stories = Object.values(index.entries).filter((e) => e.type === 'story');

/**
 * Stories whose picture is not a function of their inputs. Each needs its
 * reason: an entry here is a story nobody is watching.
 */
const UNSTABLE: Record<string, string> = {};

for (const story of stories) {
  test(`${story.title} / ${story.name}`, async ({ page }) => {
    test.skip(story.id in UNSTABLE, UNSTABLE[story.id]);
    await pinFonts(page);
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await page.waitForFunction(() => {
      const root = document.querySelector('#storybook-root');
      return !!root && root.innerHTML.trim() !== '';
    });
    // A play function runs after the first render; wait for it, as the gates do.
    await page.waitForFunction(() => {
      const renders = (
        window as unknown as { __STORYBOOK_PREVIEW__?: { storyRenders?: { phase?: string }[] } }
      ).__STORYBOOK_PREVIEW__?.storyRenders;
      if (!Array.isArray(renders)) return true;
      return renders.every(
        (r) => !r?.phase || ['finished', 'errored', 'aborted'].includes(r.phase),
      );
    });
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${story.id}.png`, { animations: 'disabled' });
  });
}
