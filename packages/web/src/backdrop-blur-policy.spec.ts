import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The blur and stacking contract (#1649, docs/design-patterns.md). A
 * `backdrop-filter` layer is its own compositing layer, and on iOS WebKit such a
 * layer painted over higher z-index surfaces regardless (#1522): the header's
 * blur showed through the open Now Playing sheet's top band. So a blur may sit
 * only where it cannot end up under the sheet — a modal backdrop, inside a
 * surface that owns its stacking context, a chrome-less page, a transient
 * floating panel, or an in-page layer that stands down while the sheet covers
 * it. Never on persistent chrome (header, mini player, tab bar). Every site is
 * declared here, so a new one has to be placed in the contract. A template site
 * is one match, so a file with two blurs would be listed twice; a stylesheet
 * site is one rule.
 */
const BLUR_SITES = {
  modalBackdrop: [
    'components/album-hunt-modal/album-hunt-modal.component.html',
    'components/changelog-modal/changelog-modal.component.html',
    'components/confirm-dialog/confirm-dialog.component.html',
    'components/keyboard-shortcuts-sheet/keyboard-shortcuts-sheet.component.html',
    'components/metadata-fix-modal/metadata-fix-modal.component.html',
    'components/resource-picker/resource-picker.component.html',
    'components/tv-device-picker/tv-device-picker.component.html',
    // The import drop overlay, shown only while a file is dragged over /get.
    'pages/get/get.component.html',
  ],
  insideSheet: [
    // The play/pause button.
    'components/now-playing/now-playing-karaoke-fullscreen/now-playing-karaoke-fullscreen.component.html',
    'styles.css: html.tv-build app-now-playing-transport',
    'styles.css: html.tv-build .np-tv-queue-panel',
  ],
  chromelessPage: ['pages/login/login.component.html'],
  floatingPanel: ['styles.css: .glass-panel'],
  inPageStandsDown: ['styles.css: .mosaic-rim'],
} as const;

const src = __dirname;
const app = join(src, 'app');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const appFiles = walk(app);
const rel = (file: string): string => relative(src, file).replace(/^app\//, '');

// Every Tailwind utility that emits a backdrop-filter (each makes the layer, not
// only blur), a declaration in an inline style, a `[style.backdrop-filter]`
// binding, or the property set from TS. A comment that merely names the
// property has no colon or bracket after it.
const TEMPLATE_BLUR =
  /\bbackdrop-(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\b|backdrop-filter\s*(?::(?!\s*none\b)|\])|\bbackdropFilter\b/g;

/** One site per match, so a second blur in an allowlisted file is a new site. */
const templateSites = appFiles
  .filter((file) => /\.(html|ts)$/.test(file) && !file.endsWith('.spec.ts'))
  .flatMap((file) => {
    const n = readFileSync(file, 'utf8').match(TEMPLATE_BLUR)?.length ?? 0;
    return Array.from({ length: n }, () => rel(file));
  });

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

// The global stylesheet and every component stylesheet (a `styleUrl`).
const stylesheets = [join(src, 'styles.css'), ...appFiles.filter((f) => /\.s?css$/.test(f))];
const rules = cssRules(readFileSync(join(src, 'styles.css'), 'utf8'));
const cssSites = stylesheets.flatMap((sheet) =>
  cssRules(readFileSync(sheet, 'utf8'))
    .filter((r) =>
      r.decls.some((d) => /^(?:-webkit-)?backdrop-filter:/.test(d) && !/:\s*none$/.test(d)),
    )
    .map((r) => `${rel(sheet)}: ${r.prelude}`),
);

const found = [...templateSites, ...new Set(cssSites)].sort();
const declared = Object.values(BLUR_SITES).flat().map(String).sort();

describe('backdrop blur policy (#1649)', () => {
  it('finds the blur sites it is meant to guard', () => {
    expect(found.length).toBeGreaterThanOrEqual(12);
    expect(templateSites.length).toBeGreaterThanOrEqual(8);
    expect(cssSites.length).toBeGreaterThanOrEqual(4);
    // The component stylesheets are read too (the tab bar's among them).
    expect(stylesheets.length).toBeGreaterThanOrEqual(5);
    expect(stylesheets.map(rel)).toContain('components/bottom-nav/bottom-nav.component.css');
  });

  it('recognises every way a template or stylesheet can make a backdrop-filter layer', () => {
    const hits = (text: string): number => text.match(TEMPLATE_BLUR)?.length ?? 0;
    expect(hits('class="backdrop-blur-sm"')).toBe(1);
    expect(hits('class="backdrop-saturate-150 backdrop-brightness-75"')).toBe(2);
    expect(hits(`[style.backdrop-filter]="'blur(4px)'"`)).toBe(1);
    expect(hits("el.style.backdropFilter = 'blur(4px)'")).toBe(1);
    expect(hits('style="backdrop-filter: blur(2px)"')).toBe(1);
    expect(hits('style="backdrop-filter: none"')).toBe(0);
    expect(hits('// a backdrop-filter layer is its own compositing layer')).toBe(0);
    const [rule] = cssRules('a::before { color: red; -webkit-backdrop-filter: blur(8px); }');
    expect(rule.decls).toContain('-webkit-backdrop-filter: blur(8px)');
  });

  it('every backdrop-filter site is declared in the contract, and every declared site exists', () => {
    expect(found).toEqual(declared);
  });

  it('the in-page mosaic rim stands down while Now Playing covers it', () => {
    const covered = rules.filter((r) =>
      r.prelude.split(/\s*,\s*/).includes('.mosaic-covered .mosaic-rim'),
    );
    expect(covered.flatMap((r) => r.decls)).toContain('visibility: hidden');
  });
});
