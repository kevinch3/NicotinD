/**
 * The Storybook catalog gates: render every story and fail on any that throws
 * (`--smoke`), and run axe over every story (`--a11y`, gating only under `--strict`).
 *
 *   bun run smoke:storybook            render check only
 *   bun run a11y:storybook             axe, report only, always exits 0
 *   bun run a11y:storybook:strict      axe, exit 1 on any violation
 *   bun run gates:storybook            both, both gating — what CI and `verify` run
 *
 * WHY both live in one script: they are the same traversal. Two scripts meant two
 * browsers and two full passes over 138 stories — 114s + 159s of the `ci` job to answer
 * two questions about the same page. One visit answers both, and `visitStories` spreads
 * the catalog across a pool of contexts.
 *
 * WHY smoke exists at all: `build:storybook` compiles stories, it does not run them. The
 * first green build of this catalog shipped 67 of 139 stories that threw on mount — an
 * empty router route table made every RouterLink-bearing component throw NG04002, and
 * UpdateService could not resolve SwUpdate. Both are invisible to a type check and to
 * webpack.
 *
 * WHY a11y does NOT gate by default: a new gate that starts red gets disabled rather
 * than fixed — see docs/storybook.md. It was promoted to `--strict` in CI only once it
 * was already at zero.
 *
 * The two checks keep **independent** exit contributions: smoke always gates when it
 * runs; axe gates only under `--strict`. Running them together no longer lets a smoke
 * failure short-circuit the axe report (the old `&&` between two scripts did), so one
 * run tells you about both.
 */
import AxeBuilder from '@axe-core/playwright';
import { readStories, storyUrl, visitStories } from './lib/storybook-runner.mjs';

const SMOKE = process.argv.includes('--smoke');
const A11Y = process.argv.includes('--a11y');
const STRICT = process.argv.includes('--strict');

if (!SMOKE && !A11Y) {
  console.error('Nothing to do: pass --smoke, --a11y, or both.');
  process.exit(2);
}

/**
 * A story is ready when its root has content — the exact condition the smoke check
 * asserts on — or when Storybook's error display becomes visible, which is a story that
 * failed and should be reported now rather than after a timeout.
 *
 * This replaced `waitUntil: 'networkidle'`, which imposed a hard ~500ms quiet-window
 * floor on every story on top of load. `load` still waits for stylesheets, which axe's
 * contrast rules need; only the idle window is gone.
 */
const RENDER_TIMEOUT_MS = 15_000;

function ready() {
  const root = document.querySelector('#storybook-root');
  if (root && root.innerHTML.trim() !== '') return true;
  const err = document.querySelector('.sb-errordisplay, #error-message');
  if (err) {
    const s = getComputedStyle(err);
    if (s.display !== 'none' && s.visibility !== 'hidden') return true;
  }
  return false;
}

/**
 * Run axe over one story, retrying while `@storybook/addon-a11y`'s own scan holds the
 * page's single axe instance.
 *
 * The addon is configured in `.storybook/main.ts`, so a story iframe runs axe by itself
 * on mount; a second concurrent `axe.run()` throws "Axe is already running". The old
 * `waitUntil: 'networkidle'` hid this by accident — the 500ms quiet window was long
 * enough for the addon's scan to finish before ours started. Waiting on first render
 * instead is faster and reaches the page while the addon is still scanning, so the
 * contention has to be handled rather than waited out. Nine stories hit it on the first
 * run of the merged gate.
 *
 * Only that specific error is retried; anything else is a real failure and propagates.
 */
const AXE_BUSY = /Axe is already running/;
const AXE_RETRIES = 20;
const AXE_RETRY_MS = 100;

async function analyzeWithRetry(page, story) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new AxeBuilder({ page })
        .include('#storybook-root')
        // WCAG 1.4.3 exempts text that is part of an inactive UI component, and axe only
        // applies that exemption to native :disabled controls. A disabled TrackRow is a
        // <div> with `opacity-40 pointer-events-none`, so its dimmed text was reported as
        // five contrast failures. Lightening it would defeat the disabled affordance; the
        // right answer is to mark it inactive (aria-disabled) and honour the exemption.
        .exclude('[aria-disabled="true"]')
        .analyze();
    } catch (e) {
      if (attempt >= AXE_RETRIES || !AXE_BUSY.test(String(e))) {
        throw new Error(`axe failed on ${story.id}: ${e}`);
      }
      await page.waitForTimeout(AXE_RETRY_MS);
    }
  }
}

const stories = readStories();
const failures = [];
/** rule id -> { impact, help, helpUrl, stories:Set, nodes:number, sample:string } */
const byRule = new Map();

const { errors: visitErrors } = await visitStories({
  stories,
  visit: async (page, story, base) => {
    const errors = [];
    const onErr = (e) => errors.push(String(e));
    const onConsole = (m) => {
      if (m.type() === 'error') errors.push(m.text());
    };
    page.on('pageerror', onErr);
    page.on('console', onConsole);

    try {
      await page.goto(storyUrl(base, story), { waitUntil: 'load' });
      await page.waitForFunction(ready, undefined, { timeout: RENDER_TIMEOUT_MS });
    } catch {
      // Fall through: the root/error-box reads below turn this into a reported
      // failure ("story rendered nothing") rather than an aborted run.
    }

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

    if (SMOKE) {
      // The fixture transport answers unmatched routes with a deliberate 404; that is the
      // designed behaviour (a story must never reach a real network), not a story failure.
      const real = errors.filter((e) => !/404|Not Found \(no Storybook fixture\)/i.test(e));
      if (errorBox || real.length) failures.push({ id: story.id, errorBox, errors: real.slice(0, 2) });
      else if (!root) failures.push({ id: story.id, errorBox: 'story rendered nothing', errors: [] });
    }

    if (A11Y) {
      // Listeners are detached above, so axe's own console output cannot pollute the
      // smoke error list for this story.
      const { violations } = await analyzeWithRetry(page, story);

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
  },
});

// A story the runner could not visit at all is a smoke failure — not a silent skip.
for (const { story, error } of visitErrors) {
  failures.push({ id: story.id, errorBox: `visit failed: ${error}`, errors: [] });
}

// Stories are visited concurrently, so completion order is not stable. Sort every
// collection before printing or the same catalog reports differently run to run.
failures.sort((a, b) => a.id.localeCompare(b.id));

let failed = false;

if (SMOKE) {
  console.log(`Storybook smoke: ${stories.length} stories, ${failures.length} failing`);
  for (const f of failures) console.log(JSON.stringify(f, null, 1));
  if (failures.length) failed = true;
}

if (A11Y) {
  const RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const rules = [...byRule.entries()].sort(
    (a, b) =>
      (RANK[a[1].impact] ?? 9) - (RANK[b[1].impact] ?? 9) ||
      b[1].nodes - a[1].nodes ||
      a[0].localeCompare(b[0]),
  );

  console.log(`\naxe over ${stories.length} stories — ${rules.length} distinct rule(s) violated\n`);
  for (const [id, r] of rules) {
    console.log(`[${r.impact}] ${id} — ${r.help}`);
    console.log(
      `  ${r.nodes} node(s) across ${r.stories.size} component(s): ${[...r.stories].sort().join(', ')}`,
    );
    if (r.sample) console.log(`  e.g. ${r.sample}`);
    console.log(`  ${r.helpUrl}\n`);
  }

  if (!rules.length) console.log('No violations.\n');
  if (STRICT && rules.length) failed = true;
}

process.exit(failed ? 1 : 0);
