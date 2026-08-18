/**
 * Shared plumbing for the Storybook gates: serve the static build, enumerate the
 * stories, and visit every one of them across a pool of browser contexts.
 *
 * WHY this module exists: `storybook-smoke.mjs` and `storybook-a11y.mjs` were two
 * scripts whose first ~50 lines were byte-identical — the same `MIME` map, the same
 * `serve()`, the same `index.json` enumeration, the same `iframe.html` URL shape.
 * Worse than the duplication, they each paid for a **separate full traversal** of the
 * catalog: two browsers, 138 navigations each, ~4.5 minutes of the CI `ci` job between
 * them. One traversal that runs both checks per page is most of that time back, and a
 * pool of contexts is the rest.
 *
 * Extracted rather than copied a third time — see scripts/check-shared-helpers.ts for
 * why this repo treats a re-implemented helper as a gate failure.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { extname, join, resolve } from 'node:path';

export const STATIC_DIR = resolve(import.meta.dirname, '../../../web/storybook-static');

export const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Serve `STATIC_DIR` on an ephemeral port. The only prerequisite is that the build exists. */
export function serve() {
  const server = createServer((req, res) => {
    const path = join(STATIC_DIR, decodeURIComponent(req.url.split('?')[0]));
    readFile(path, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

/**
 * Every real story in the built catalog, as whole index entries — the a11y pass groups
 * by `title`, the smoke pass reports by `id`, so neither field can be dropped here.
 * `.mdx` files produce `type: 'docs'` entries and are not stories.
 */
export function readStories() {
  const index = JSON.parse(readFileSync(join(STATIC_DIR, 'index.json'), 'utf8'));
  return Object.values(index.entries).filter((e) => e.type === 'story');
}

/**
 * How many contexts to drive at once. The work is CPU-bound (Angular bootstrap per
 * story, plus axe), so this tracks cores rather than being a fixed number, and is
 * capped because past that the contexts just contend. `STORYBOOK_GATE_CONCURRENCY`
 * overrides it for debugging — 1 restores the old strictly-serial behaviour.
 */
export function defaultConcurrency() {
  const override = Number(process.env.STORYBOOK_GATE_CONCURRENCY);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(1, Math.min(4, availableParallelism()));
}

/** The URL a story renders at, standalone (no Storybook manager chrome). */
export function storyUrl(base, story) {
  return `${base}/iframe.html?id=${story.id}&viewMode=story`;
}

/**
 * Visit every story exactly once, calling `visit(page, story)` for each.
 *
 * Each worker owns a context+page pair reused across its share of the stories —
 * a page per story would pay a fresh renderer for all 138. `AxeBuilder` refuses a page
 * from `browser.newPage()` (it needs an explicit context), so a context is always
 * created even though the smoke checks alone would not require one.
 *
 * `visit` rejecting is reported as a per-story error rather than taking down the run:
 * before this, a single story whose navigation never settled killed the whole pass with
 * an unhandled rejection and leaked both the server and the browser.
 */
export async function visitStories({ stories, concurrency = defaultConcurrency(), visit }) {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chromium' });

  // `channel: 'chromium'` uses the full Chromium build that `playwright install chromium`
  // provides. The default launch path wants the separately-downloaded
  // `chrome-headless-shell`, which CI does not have — it failed there while passing on
  // any machine that had previously run the e2e suite.

  const queue = [...stories];
  const errors = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      for (;;) {
        const story = queue.shift();
        if (!story) break;
        try {
          await visit(page, story, base);
        } catch (e) {
          errors.push({ story, error: String(e) });
        }
      }
    } finally {
      await context.close();
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    await browser.close();
    server.close();
  }

  return { errors };
}
