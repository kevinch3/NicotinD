import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseTemplate } from '@angular/compiler';
import { describe, expect, it } from 'vitest';

/**
 * Nothing is wider than its container (#1807, docs/web-ui.md "Rows never widen
 * the page"). The e2e sweep (`horizontal-overflow.spec.ts`) measures what the
 * fixture data renders; this reads every template for the shapes that overflow
 * once the data is longer or the locale wordier, so a new one fails here before
 * it ships. Each rule is one line of the rule set:
 *
 * - **R1 rigid button row** — a flex row of two or more *text* buttons/links that
 *   cannot wrap: three or more of them, or a group that is itself `shrink-0`.
 * - **R2 intrinsic form control** — an `<input>`/`<select>` in a flex row with no
 *   width of its own and no `min-w-0`: it is as wide as ~20ch or its longest option.
 * - **R3 truncation that cannot engage** — a flex or grid item without `min-w-0`
 *   whose descendant truncates: the item's minimum is its content width, so the
 *   ellipsis never happens and the row widens instead.
 * - **R4 bare `1fr` track** — an arbitrary grid template with `1fr` (which is
 *   `minmax(auto, 1fr)`) instead of `minmax(0,1fr)`.
 * - **R5 unframed table** — a `<table>` outside an `overflow-x-auto` frame
 *   (`section-flush`), or a truncating cell in a table that is not `table-fixed`
 *   (or the cell is not `max-w-0`).
 * - **R6 nowrap outside a strip** — `whitespace-nowrap` that is not `truncate`
 *   and not inside a horizontal scroller.
 *
 * Not a rule: `truncate` directly on a flex item. Its `overflow: hidden` already
 * makes the item's automatic minimum 0, so it shrinks.
 *
 * A site that is genuinely fine (a short fixed label, a two-button dialog
 * footer that fits at 320 px in Spanish) is listed below with its reason. One
 * entry per site: a file with two allowed sites is listed twice, so a third is new.
 */
const ALLOWED: Record<string, Record<string, readonly string[]>> = {
  R1: {
    // Install + Dismiss, short in every locale, beside a min-w-0 text column.
    twoShortLabels: ['components/install-promo/install-promo-banner.component.html'],
    // The TV home: a 960 px leanback canvas, never a phone.
    tvOnly: ['pages/tv/tv-home.component.ts'],
  },
  R2: {},
  R3: {},
  R4: {},
  R5: {
    // `w-full` in a min-w-0 column, and its one text cell truncates (`max-w-0 w-full`).
    boundedTable: ['components/genre-radar/genre-radar.component.html'],
  },
  R6: {
    // A percentage and a count: a few digits each.
    number: [
      'components/genre-radar/genre-radar.component.html',
      'components/genre-radar/genre-radar.component.html',
    ],
    // One short label beside a `min-w-0 flex-1` input: the input gives way.
    besideFlexibleInput: [
      'components/search-field/search-field.component.html',
      'pages/setup/setup.component.html',
    ],
  },
};

// ── Template collection ────────────────────────────────────────────────────

const src = __dirname;
const app = join(src, 'app');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const rel = (file: string): string => relative(app, file);

interface Template {
  file: string;
  source: string;
  /** Line offset of an inline template inside its `.ts` file. */
  line: number;
}

function templates(): Template[] {
  const out: Template[] = [];
  for (const file of walk(app)) {
    if (file.endsWith('.html')) {
      out.push({ file, source: readFileSync(file, 'utf8'), line: 0 });
    } else if (
      file.endsWith('.ts') &&
      !file.endsWith('.spec.ts') &&
      !file.endsWith('.stories.ts')
    ) {
      const text = readFileSync(file, 'utf8');
      const m = /template:\s*`/.exec(text);
      if (!m) continue;
      const start = m.index + m[0].length;
      const end = text.indexOf('`', start);
      out.push({
        file,
        source: text.slice(start, end),
        line: text.slice(0, start).split('\n').length - 1,
      });
    }
  }
  return out;
}

// ── AST helpers (structural: the compiler's node classes are not exported stably) ──

interface Attr {
  name: string;
  value: string;
}
interface El {
  name: string;
  attributes: Attr[];
  inputs: Array<{ name: string; value?: { source?: string } }>;
  children: unknown[];
  sourceSpan: { start: { line: number } };
}
const isElement = (n: unknown): n is El =>
  !!n &&
  typeof (n as El).name === 'string' &&
  Array.isArray((n as El).attributes) &&
  Array.isArray((n as El).children);

/** Children of a control-flow block (`@if` branches, `@for` body/empty, …). */
function blockChildren(n: unknown): unknown[] {
  const o = n as Record<string, unknown>;
  const out: unknown[] = [];
  for (const k of ['children', 'branches', 'cases']) {
    if (Array.isArray(o[k])) out.push(...(o[k] as unknown[]));
  }
  for (const k of ['empty', 'placeholder', 'loading', 'error']) if (o[k]) out.push(o[k]);
  return out;
}

/** The element children of a node, looking through control flow. */
function elementChildren(n: { children?: unknown[] }): El[] {
  const out: El[] = [];
  const visit = (x: unknown): void => {
    if (!x) return;
    if (isElement(x)) {
      // <ng-container> / <ng-template> are not boxes: their children are.
      if (x.name === 'ng-container' || x.name === 'ng-template') x.children.forEach(visit);
      else out.push(x);
      return;
    }
    blockChildren(x).forEach(visit);
  };
  (n.children ?? []).forEach(visit);
  return out;
}

/** Every static class token on the element: `class="…"` and the string literals of `[class]`. */
function classes(el: El): Set<string> {
  let s = '';
  for (const a of el.attributes) if (a.name === 'class') s += ` ${a.value}`;
  for (const i of el.inputs ?? []) {
    if (i.name === 'class') s += ` ${(i.value?.source ?? '').replace(/['"`+?:()]/g, ' ')}`;
  }
  return new Set(s.split(/\s+/).filter(Boolean));
}

function textOf(n: unknown): string {
  let t = '';
  const visit = (x: unknown): void => {
    if (!x) return;
    const o = x as { value?: unknown };
    if (typeof o.value === 'string') t += o.value;
    else if (o.value && typeof (o.value as { source?: string }).source === 'string') {
      t += (o.value as { source: string }).source;
    }
    if (isElement(x)) x.children.forEach(visit);
    else blockChildren(x).forEach(visit);
  };
  visit(n);
  return t.replace(/\s+/g, '');
}

const has = (c: Set<string>, ...tokens: string[]): boolean => tokens.some((t) => c.has(t));
const any = (c: Set<string>, re: RegExp): boolean => [...c].some((t) => re.test(t));

/** A row on a phone: `flex`/`inline-flex`, not a column below `sm`. */
const isFlexRow = (c: Set<string>): boolean => has(c, 'flex', 'inline-flex') && !c.has('flex-col');
const scrollsX = (c: Set<string>): boolean =>
  has(c, 'overflow-x-auto', 'overflow-x-scroll', 'overflow-auto', 'section-flush');
/** Stops a child's overflow reaching the page: clips, scrolls or truncates. */
const containsX = (c: Set<string>): boolean =>
  scrollsX(c) ||
  has(
    c,
    'overflow-hidden',
    'overflow-x-hidden',
    'overflow-clip',
    'overflow-x-clip',
    // A y scroller's overflow-x computes to auto: it scrolls its own overflow.
    'overflow-y-auto',
    'overflow-y-scroll',
    'truncate',
  );
/** Has a width of its own, or a deliberate floor (`min-w-[10rem]` beside wrapping buttons). */
const bounded = (c: Set<string>): boolean => any(c, /^(w|min-w|max-w|basis|size)-(\d|\[|xs|full)/);
/** Out of flow: an overlay, a fixed menu panel. It widens no row. */
const outOfFlow = (el: El): boolean =>
  el.name === 'app-menu-panel' || has(classes(el), 'absolute', 'fixed', 'sr-only');

const isTextButton = (el: El): boolean => {
  if (el.name !== 'button' && el.name !== 'a') return false;
  const c = classes(el);
  // A fixed-size icon button cannot grow with a label.
  if (any(c, /^(w|size)-(\d|\[)/)) return false;
  return textOf(el).length > 1;
};

const truncates = (el: El): boolean =>
  any(classes(el), /^(truncate|line-clamp-\d+)$/) ||
  el.attributes.some((a) => a.name === 'appOverflowReveal');

/**
 * Some descendant truncates against the row's width — not counting one with a
 * width of its own (`truncate max-w-[12rem]` is bounded already), nor below an
 * element that already lets it shrink or is out of flow.
 */
function descendantTruncates(el: El): boolean {
  for (const child of elementChildren(el)) {
    if (outOfFlow(child)) continue;
    const c = classes(child);
    if (truncates(child)) {
      if (!bounded(c)) return true;
      continue;
    }
    if (has(c, 'min-w-0') || any(c, /^overflow-/)) continue;
    if (descendantTruncates(child)) return true;
  }
  return false;
}

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'password',
  'number',
  'tel',
  'time',
  'date',
]);

// ── The rules ──────────────────────────────────────────────────────────────

interface Site {
  rule: string;
  file: string;
  line: number;
}

function audit(): { sites: Site[]; templateCount: number; flexRows: number } {
  const sites: Site[] = [];
  let flexRows = 0;
  const list = templates();
  for (const t of list) {
    const parsed = parseTemplate(t.source, t.file, { preserveWhitespaces: false });
    expect(parsed.errors ?? [], `${rel(t.file)} parses`).toEqual([]);
    const hit = (rule: string, el: El): void => {
      sites.push({ rule, file: rel(t.file), line: el.sourceSpan.start.line + 1 + t.line });
    };

    const visit = (nodes: unknown[], ancestors: Set<string>[]): void => {
      for (const n of nodes) {
        if (!isElement(n)) {
          if (n) visit(blockChildren(n), ancestors);
          continue;
        }
        const c = classes(n);
        const parent = ancestors[ancestors.length - 1];
        const inScroller = ancestors.some(scrollsX);
        const kids = elementChildren(n);

        if (isFlexRow(c)) flexRows++;

        // R1: rigid button row.
        if (isFlexRow(c) && !c.has('flex-wrap') && !scrollsX(c) && !inScroller) {
          const textButtons = kids.filter(isTextButton).length;
          if (textButtons >= 3 || (textButtons >= 2 && has(c, 'shrink-0', 'flex-shrink-0'))) {
            hit('R1', n);
          }
        }

        // R2: a form control with only its intrinsic width, in a row.
        if (
          (n.name === 'input' || n.name === 'select') &&
          parent &&
          isFlexRow(parent) &&
          !inScroller
        ) {
          const type = n.attributes.find((a) => a.name === 'type')?.value ?? '';
          const sized =
            has(c, 'min-w-0', 'w-full', 'size-full') ||
            any(c, /^(w|max-w|basis)-(\d|\[|xs|sm|md|lg|full)/);
          // Out of flow (an invisible overlay select, a visually hidden input) widens nothing.
          const hidden = outOfFlow(n) || c.has('hidden');
          if ((n.name === 'select' || TEXT_INPUT_TYPES.has(type)) && !sized && !hidden)
            hit('R2', n);
        }

        // R3: a flex/grid item whose truncating descendant can never engage. A grid
        // item counts only under an arbitrary template: built-in `grid-cols-N` tracks
        // are minmax(0,1fr), and an item's automatic minimum does not apply to them.
        if (
          parent &&
          (isFlexRow(parent) || any(parent, /^grid-cols-\[/)) &&
          !has(c, 'min-w-0', 'shrink-0', 'flex-shrink-0', 'flex-none') &&
          !containsX(c) &&
          !bounded(c) &&
          !outOfFlow(n) &&
          !truncates(n) &&
          descendantTruncates(n)
        ) {
          hit('R3', n);
        }

        // R4: a bare 1fr in an arbitrary grid template.
        for (const token of c) {
          const m = /^grid-cols-\[(.+)\]$/.exec(token);
          if (m && /(^|_)1fr/.test(m[1].replace(/minmax\(0,1fr\)/g, ''))) hit('R4', n);
        }

        // R5: tables.
        if (n.name === 'table') {
          if (!inScroller) hit('R5', n);
          if (!c.has('table-fixed')) {
            const cells: El[] = [];
            const collect = (x: El): void => {
              for (const k of elementChildren(x)) {
                // `max-w-0` (with a width) is the auto-layout way to let a cell truncate.
                if (
                  (k.name === 'td' || k.name === 'th') &&
                  truncates(k) &&
                  !classes(k).has('max-w-0')
                ) {
                  cells.push(k);
                }
                collect(k);
              }
            };
            collect(n);
            cells.forEach((cell) => hit('R5', cell));
          }
        }

        // R6: nowrap that is neither a truncation nor inside a strip.
        if (c.has('whitespace-nowrap') && !c.has('truncate') && !inScroller && !scrollsX(c)) {
          hit('R6', n);
        }

        visit(n.children, [...ancestors, c]);
      }
    };
    visit(parsed.nodes, []);
  }
  return { sites, templateCount: list.length, flexRows };
}

describe('horizontal overflow policy (#1807)', () => {
  const { sites, templateCount, flexRows } = audit();

  it('reads the whole web app (asserts its own denominator)', () => {
    // A walker that silently stopped finding templates would pass every rule.
    expect(templateCount).toBeGreaterThanOrEqual(120);
    expect(flexRows).toBeGreaterThanOrEqual(400);
  });

  for (const rule of Object.keys(ALLOWED)) {
    it(`${rule}: every site follows the rule or is allowed with a reason`, () => {
      const found = sites
        .filter((s) => s.rule === rule)
        .map((s) => s.file)
        .sort();
      const allowed = Object.values(ALLOWED[rule]).flat().sort();
      const unexpected = [...found];
      for (const file of allowed) {
        const i = unexpected.indexOf(file);
        if (i >= 0) unexpected.splice(i, 1);
      }
      const where = sites
        .filter((s) => s.rule === rule && unexpected.includes(s.file))
        .map((s) => `${s.file}:${s.line}`);
      expect(where, `${rule}: new sites (fix them, or allow with a reason)`).toEqual([]);
      // A stale entry: the site was fixed, so the allowance must go too.
      const stale = [...allowed];
      for (const file of found) {
        const i = stale.indexOf(file);
        if (i >= 0) stale.splice(i, 1);
      }
      expect(stale, `${rule}: allowed sites that no longer exist`).toEqual([]);
    });
  }
});
