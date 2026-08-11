/**
 * Run axe against every Storybook story and report violations grouped by rule.
 *
 *   bun run a11y:storybook              report only, always exits 0
 *   bun run a11y:storybook -- --strict  exit 1 on any violation
 *
 * The addon shows violations one story at a time in the Storybook UI, which is the right
 * surface while fixing a component. This script is the other half: the whole-catalog
 * view you need to decide what to fix first, and the thing that can eventually gate CI.
 *
 * It deliberately does NOT gate by default. A new gate that starts red gets disabled
 * rather than fixed — see docs/storybook.md.
 *
 * Serves `packages/web/storybook-static` itself, so the only prerequisite is that the
 * static build exists.
 */
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const STRICT = process.argv.includes('--strict');
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
const stories = Object.values(index.entries).filter((e) => e.type === 'story');

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium' });
// AxeBuilder refuses a page from browser.newPage() — it needs an explicit context.
const context = await browser.newContext();
const page = await context.newPage();

/** rule id -> { impact, help, helpUrl, stories:Set, nodes:number, sample:string } */
const byRule = new Map();

for (const story of stories) {
  await page.goto(`${base}/iframe.html?id=${story.id}&viewMode=story`, {
    waitUntil: 'networkidle',
  });
  const { violations } = await new AxeBuilder({ page }).include('#storybook-root').analyze();

  for (const v of violations) {
    const entry = byRule.get(v.id) ?? {
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      stories: new Set(),
      nodes: 0,
      sample: v.nodes[0]?.html?.slice(0, 120) ?? '',
    };
    entry.stories.add(story.title);
    entry.nodes += v.nodes.length;
    byRule.set(v.id, entry);
  }
}

await context.close();
await browser.close();
server.close();

const RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const rules = [...byRule.entries()].sort(
  (a, b) => (RANK[a[1].impact] ?? 9) - (RANK[b[1].impact] ?? 9) || b[1].nodes - a[1].nodes,
);

console.log(`\naxe over ${stories.length} stories — ${rules.length} distinct rule(s) violated\n`);
for (const [id, r] of rules) {
  console.log(`[${r.impact}] ${id} — ${r.help}`);
  console.log(`  ${r.nodes} node(s) across ${r.stories.size} component(s): ${[...r.stories].join(', ')}`);
  if (r.sample) console.log(`  e.g. ${r.sample}`);
  console.log(`  ${r.helpUrl}\n`);
}

if (!rules.length) console.log('No violations.\n');
process.exit(STRICT && rules.length ? 1 : 0);
