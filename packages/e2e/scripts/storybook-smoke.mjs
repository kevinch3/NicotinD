/**
 * Render every Storybook story and fail on any that throws.
 *
 *   bun run smoke:storybook          (from the repo root)
 *
 * WHY this exists as a separate gate: `build:storybook` compiles stories, it does not
 * run them. The first green build of this catalog shipped 67 of 139 stories that threw
 * on mount — an empty router route table made every RouterLink-bearing component throw
 * NG04002, and UpdateService could not resolve SwUpdate. Both are invisible to a type
 * check and to webpack. A catalog that compiles but does not render is worse than none,
 * because it looks maintained.
 *
 * Serves `packages/web/storybook-static` itself on an ephemeral port, so the only
 * prerequisite is that the static build exists.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const STATIC_DIR = resolve(import.meta.dirname, '../../web/storybook-static');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serve() {
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

const index = JSON.parse(readFileSync(join(STATIC_DIR, 'index.json'), 'utf8'));
const ids = Object.values(index.entries)
  .filter((e) => e.type === 'story')
  .map((e) => e.id);

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
// `channel: 'chromium'` uses the full Chromium build that `playwright install chromium`
// provides. The default launch path wants the separately-downloaded
// `chrome-headless-shell`, which CI does not have — it failed there while passing on
// any machine that had previously run the e2e suite.
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
const failures = [];

for (const id of ids) {
  const errors = [];
  const onErr = (e) => errors.push(String(e));
  const onConsole = (m) => {
    if (m.type() === 'error') errors.push(m.text());
  };
  page.on('pageerror', onErr);
  page.on('console', onConsole);

  await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`, { waitUntil: 'networkidle' });

  const root = await page.evaluate(
    () => document.querySelector('#storybook-root')?.innerHTML.trim() ?? null,
  );
  // Storybook's error <div> is always in iframe.html; only a *visible* one is a failure.
  const errorBox = await page.evaluate(() => {
    const el = document.querySelector('.sb-errordisplay, #error-message');
    if (!el) return null;
    const s = getComputedStyle(el);
    const visible = s.display !== 'none' && s.visibility !== 'hidden';
    return visible ? (el.textContent ?? '').slice(0, 300) : null;
  });

  page.off('pageerror', onErr);
  page.off('console', onConsole);

  // The fixture transport answers unmatched routes with a deliberate 404; that is the
  // designed behaviour (a story must never reach a real network), not a story failure.
  const real = errors.filter((e) => !/404|Not Found \(no Storybook fixture\)/i.test(e));

  if (errorBox || real.length) failures.push({ id, errorBox, errors: real.slice(0, 2) });
  else if (!root) failures.push({ id, errorBox: 'story rendered nothing', errors: [] });
}

await browser.close();
server.close();

console.log(`Storybook smoke: ${ids.length} stories, ${failures.length} failing`);
for (const f of failures) console.log(JSON.stringify(f, null, 1));
process.exit(failures.length ? 1 : 0);
