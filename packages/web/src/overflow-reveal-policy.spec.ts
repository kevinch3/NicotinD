import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Names are never unreadably truncated (#1665, docs/design-patterns.md). Every
 * element a template truncates — Tailwind `truncate` / `text-ellipsis` /
 * `line-clamp-*`, or a stylesheet class that sets `text-overflow: ellipsis` or
 * `-webkit-line-clamp` — must carry `appOverflowReveal` (or, in markup built
 * as a string, `data-overflow-reveal`), or be listed here as a truncation that
 * is not a name. One entry per site: a file with two allowed sites is listed
 * twice, so a third one in it is a new site.
 */
const NOT_A_NAME = {
  // An error or status message, with its own `title` where it can run long.
  message: [
    'components/download-item/download-item.component.html',
    'components/download-item/download-item.component.html',
    'pages/search/search.component.html',
    'pages/search/search.component.html',
    'pages/search/search.component.html',
  ],
  // A secret or a URL: copied, not read.
  secretOrUrl: [
    'pages/search/search.component.html',
    'pages/server-config/server-config.component.html',
    'pages/settings/agent-tokens/agent-tokens.component.html',
    'pages/settings/subsonic-keys/subsonic-keys.component.html',
    'pages/settings/subsonic-keys/subsonic-keys.component.html',
  ],
  // Fixed UI copy or a count line, no user content in it.
  uiCopy: [
    'components/import-drop-card/import-drop-card.component.html',
    'components/playing-elsewhere/playing-elsewhere.component.html',
    'components/resource-picker/resource-picker.component.html',
    'pages/get/get.component.html',
    'pages/library/library.component.html',
    'pages/search/search.component.html',
    'pages/search/search.component.html',
    'pages/search/search.component.html',
    'pages/search/search.component.html',
  ],
  // Admin progress and diagnostic lines.
  diagnostic: [
    'components/metric-pill/metric-pill.component.html',
    'pages/admin/library-health/library-health-panel.component.html',
    'pages/admin/library-maintenance/library-maintenance-panel.component.html',
    'pages/admin/library-processing/library-processing-panel.component.html',
    'pages/admin/radio-polls/radio-polls-card.component.html',
  ],
  // The user's own query in an input, which scrolls under the caret natively.
  nativeInput: ['components/search-field/search-field.component.html'],
  // A multi-line clamp with its own "Show more".
  ownExpander: ['components/artist-info/artist-info.component.html'],
} as const;

/** A class string built in TS and bound with `[class]`: the binding site must carry the directive. */
const CLASS_STRINGS: Record<string, { template: string; binding: string }> = {
  'components/download-item/download-item.component.ts': {
    template: 'components/download-item/download-item.component.html',
    binding: '[class]="titleClass"',
  },
  'components/vibe-tile/vibe-tile.component.ts': {
    template: 'components/vibe-tile/vibe-tile.component.ts',
    binding: '[class]="labelClasses()"',
  },
};

const src = __dirname;
const app = join(src, 'app');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const appFiles = walk(app);
const rel = (file: string): string => relative(src, file).replace(/^app\//, '');
const read = (file: string): string => readFileSync(file, 'utf8');

interface Rule {
  prelude: string;
  decls: string[];
}

/** Every rule block in a stylesheet, at any nesting depth, comments stripped. */
function cssRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const stack: Rule[] = [];
  let buf = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      const rule = { prelude: buf.trim().replace(/\s+/g, ' '), decls: [] };
      rules.push(rule);
      stack.push(rule);
      buf = '';
    } else if (ch === ';' || ch === '}') {
      const decl = buf.trim().replace(/\s+/g, ' ');
      if (decl && stack.length) stack[stack.length - 1].decls.push(decl);
      buf = '';
      if (ch === '}') stack.pop();
    } else {
      buf += ch;
    }
  }
  return rules;
}

const TRUNCATING_DECL = /^(?:text-overflow:\s*ellipsis|-webkit-line-clamp:)/;
const CLAMP_DECL = /^-webkit-line-clamp:/;
const stylesheets = [join(src, 'styles.css'), ...appFiles.filter((f) => /\.s?css$/.test(f))];

/** A component stylesheet styles its own template only; `styles.css` styles them all. */
const scopeOf = (sheet: string): string =>
  sheet.endsWith('styles.css') ? '*' : rel(sheet).replace(/\.s?css$/, '');

interface SheetTruncation {
  /** Classes on a truncating rule's subject, which every template use must honour. */
  classes: string[];
  /** The subset that clamps to several lines, where a sideways reveal cannot move. */
  clamps: string[];
  /** Rules whose subject has no class (`.face span`): each is a site of its own. */
  sites: string[];
}

function sheetTruncation(name: string, css: string): SheetTruncation {
  const out: SheetTruncation = { classes: [], clamps: [], sites: [] };
  for (const rule of cssRules(css)) {
    if (!rule.decls.some((d) => TRUNCATING_DECL.test(d))) continue;
    const clamps = rule.decls.some((d) => CLAMP_DECL.test(d));
    for (const selector of rule.prelude.split(',')) {
      const subject =
        selector
          .trim()
          .split(/[\s>+~]+/)
          .pop() ?? '';
      const classes = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      // The reveal's own state class switches the ellipsis off; it truncates nothing.
      if (classes.some((c) => c.startsWith('overflow-reveal'))) continue;
      if (!classes.length) out.sites.push(`${name}: ${selector.trim()}`);
      out.classes.push(...classes);
      if (clamps) out.clamps.push(...classes);
    }
  }
  return out;
}

const cssClasses = new Map<string, Set<string>>();
const clampClasses = new Map<string, Set<string>>();
const cssSites: string[] = [];
for (const sheet of stylesheets) {
  const found = sheetTruncation(rel(sheet), read(sheet));
  cssSites.push(...found.sites);
  for (const [into, list] of [
    [cssClasses, found.classes],
    [clampClasses, found.clamps],
  ] as const) {
    const scope = into.get(scopeOf(sheet)) ?? new Set<string>();
    list.forEach((c) => scope.add(c));
    into.set(scopeOf(sheet), scope);
  }
}
const allCssClasses = [...cssClasses.values()].flatMap((s) => [...s]);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The truncating tokens a file can use: Tailwind's, the global classes, its own stylesheet's. */
function tokenFor(file: string): RegExp {
  const classes = [
    ...(cssClasses.get('*') ?? []),
    ...(cssClasses.get(file.replace(/\.(html|ts)$/, '')) ?? []),
  ];
  return new RegExp(
    `(?<![\\w-])(?:truncate|text-ellipsis|line-clamp-(?:\\d+|\\[[^\\]]+\\])${classes
      .map((c) => `|${escape(c)}`)
      .join('')})(?![\\w-])`,
    'g',
  );
}

/** Comments name the classes in prose; they are not sites. */
function stripComments(text: string, ts: boolean): string {
  let out = text.replace(/<!--[\s\S]*?-->/g, '');
  if (ts) out = out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return out;
}

/** The [start, end) of every opening tag, quotes respected, so a tag may span lines. */
function tagSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open = /<([a-zA-Z][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    let quote: string | null = null;
    let i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>' || ch === '<') break;
    }
    spans.push([m.index, i + 1]);
    open.lastIndex = i;
  }
  return spans;
}

interface Site {
  file: string;
  tag: string | null;
}

/** Every truncation in one template or component source. `tag` is null for a TS class string. */
function sitesIn(file: string, text: string): Site[] {
  const body = stripComments(text, file.endsWith('.ts'));
  const spans = tagSpans(body);
  return [...body.matchAll(tokenFor(file))].map((m) => {
    const span = spans.find(([s, e]) => m.index! >= s && m.index! < e);
    return { file, tag: span ? body.slice(span[0], span[1]) : null };
  });
}

const REVEAL_ATTR = /(?<![\w-])appOverflowReveal(?![\w-])/;
/** The string-markup marker (`REVEAL_MARKER_ATTR`); inert unless its writer attaches it. */
const REVEAL_MARKER = /(?<![\w-])data-overflow-reveal(?![\w-])/;
const revealed = (tag: string): boolean => REVEAL_ATTR.test(tag) || REVEAL_MARKER.test(tag);

/** A line clamp wraps instead of overflowing sideways, so a reveal on it never moves. */
function clampsLines(file: string, tag: string): boolean {
  const classes = [
    ...(clampClasses.get('*') ?? []),
    ...(clampClasses.get(file.replace(/\.(html|ts)$/, '')) ?? []),
  ];
  return new RegExp(
    `(?<![\\w-])(?:line-clamp-(?:\\d+|\\[[^\\]]+\\])${classes.map((c) => `|${escape(c)}`).join('')})(?![\\w-])`,
  ).test(tag);
}

const sources = appFiles.filter((f) => /\.(html|ts)$/.test(f) && !/\.(spec|stories)\.ts$/.test(f));
const sites = sources.flatMap((f) => sitesIn(rel(f), read(f)));
const tagSites = sites.filter((s) => s.tag !== null);
const covered = tagSites.filter((s) => revealed(s.tag!));
const markerSites = covered.filter((s) => REVEAL_MARKER.test(s.tag!));
const uncovered = tagSites.filter((s) => !revealed(s.tag!)).map((s) => s.file);
const classStringSites = sites.filter((s) => s.tag === null).map((s) => s.file);

/** The component source whose `imports` must bring the directive in. */
const componentOf = (file: string): string => file.replace(/\.html$/, '.ts');

describe('overflow reveal policy (#1665)', () => {
  it('finds the truncations it is meant to guard', () => {
    expect(sources.length).toBeGreaterThanOrEqual(300);
    expect(tagSites.length).toBeGreaterThanOrEqual(150);
    expect(covered.length).toBeGreaterThanOrEqual(120);
    // Stylesheet truncation is read too: the TV queue rows.
    expect(allCssClasses).toEqual(
      expect.arrayContaining(['np-tv-queue-title', 'np-tv-queue-artist']),
    );
    // The home mosaic's string-built faces: a title and a subtitle on each of three face kinds.
    expect(markerSites.filter((s) => s.file.startsWith('pages/mosaic-home/')).length).toBe(6);
  });

  it('recognises every way a template can truncate', () => {
    const tags = (html: string) => sitesIn('x.html', html).map((s) => s.tag);
    expect(tags('<p class="text-sm truncate">{{ a }}</p>')).toHaveLength(1);
    expect(tags('<span [class.truncate]="on">x</span>')).toHaveLength(1);
    expect(tags('<p class="line-clamp-2">x</p><p class="line-clamp-[3]">y</p>')).toHaveLength(2);
    expect(tags('<input class="text-ellipsis" />')).toHaveLength(1);
    expect(tags('<span class="np-tv-queue-title">x</span>')).toHaveLength(1);
    // A tag split over lines, with a `>` inside a binding, is still one tag.
    expect(
      tags('<p\n  [title]="a > b ? x : y"\n  class="truncate"\n  appOverflowReveal\n>x</p>'),
    ).toEqual([expect.stringContaining('appOverflowReveal')]);
    // Prose about the class is not a site; neither is a lookalike word.
    expect(tags('<!-- a truncate here --><p class="untruncated truncated">x</p>')).toEqual([]);
    expect(sitesIn('x.ts', '/** `truncate` is inert */\nconst c = "a truncate";')).toEqual([
      { file: 'x.ts', tag: null },
    ]);
    // Markup built as a string is read too, marker and all.
    expect(tags('const face = `<b class="truncate" data-overflow-reveal>${t}</b>`;')).toEqual([
      expect.stringMatching(REVEAL_MARKER),
    ]);
  });

  it('reads a stylesheet rule as a class to honour, a clamp, or a site of its own', () => {
    const css = `.face b { -webkit-line-clamp: 2; overflow: hidden; }
      .face .name, .clip { text-overflow: ellipsis; }
      .face .name.overflow-reveal-active { text-overflow: clip; }
      .face span { opacity: 0.75; }`;
    expect(sheetTruncation('x.css', css)).toEqual({
      classes: ['name', 'clip'],
      clamps: [],
      sites: ['x.css: .face b'],
    });
    expect(sheetTruncation('x.css', '.c { -webkit-line-clamp: 3; }').clamps).toEqual(['c']);
    expect(clampsLines('x.html', '<p class="line-clamp-2" appOverflowReveal>')).toBe(true);
    expect(clampsLines('x.html', '<p class="truncate" appOverflowReveal>')).toBe(false);
  });

  it('puts every truncated name behind the reveal, or on the not-a-name list', () => {
    const declared = [...Object.values(NOT_A_NAME).flat()].filter((e) => !e.includes(': '));
    expect([...uncovered].sort()).toEqual([...declared].sort());
  });

  it('lists every stylesheet truncation whose subject has no class', () => {
    const declared = [...Object.values(NOT_A_NAME).flat()].filter((e) => e.includes(': '));
    expect([...cssSites].sort()).toEqual([...declared].sort());
  });

  it('never puts the reveal on a multi-line clamp, which it cannot move', () => {
    const inert = covered.filter((s) => clampsLines(s.file, s.tag!)).map((s) => s.file);
    expect(inert).toEqual([]);
  });

  it('binds every truncating class string onto an element that carries the reveal', () => {
    expect([...new Set(classStringSites)].sort()).toEqual(Object.keys(CLASS_STRINGS).sort());
    for (const { template, binding } of Object.values(CLASS_STRINGS)) {
      const tag = tagSpans(read(join(app, template)))
        .map(([s, e]) => read(join(app, template)).slice(s, e))
        .find((t) => t.includes(binding));
      expect(tag, `${template} binds ${binding}`).toBeDefined();
      expect(tag, `${template} ${binding}`).toMatch(REVEAL_ATTR);
    }
  });

  it('imports the directive wherever a template uses it, or the attribute does nothing', () => {
    const users = sources.filter((f) => {
      const body = stripComments(read(f), f.endsWith('.ts'));
      return tagSpans(body).some(([s, e]) => REVEAL_ATTR.test(body.slice(s, e)));
    });
    expect(users.length).toBeGreaterThanOrEqual(40);
    const missing = users
      .map((f) => componentOf(f))
      .filter((ts) => !/imports:\s*\[[^\]]*\bOverflowRevealDirective\b/.test(read(ts)))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it('attaches the reveal wherever string markup carries the marker, or the marker does nothing', () => {
    const writers = [...new Set(markerSites.map((s) => componentOf(s.file)))];
    expect(writers).toContain('pages/mosaic-home/mosaic-home.component.ts');
    const missing = writers.filter(
      (ts) => !/\battachOverflowReveals\(/.test(stripComments(read(join(app, ts)), true)),
    );
    expect(missing).toEqual([]);
  });
});
