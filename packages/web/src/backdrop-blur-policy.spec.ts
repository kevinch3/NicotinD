import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
 * declared here, so a new one has to be placed in the contract.
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
    'components/now-playing/now-playing-karaoke-fullscreen/now-playing-karaoke-fullscreen.component.html',
    'styles.css: html.tv-build app-now-playing-transport',
    'styles.css: html.tv-build .np-tv-queue-panel',
  ],
  chromelessPage: ['pages/login/login.component.html'],
  floatingPanel: ['styles.css: .glass-panel'],
  inPageStandsDown: ['styles.css: .mosaic-rim'],
} as const;

const app = join(__dirname, 'app');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(html|ts)$/.test(name) && !name.endsWith('.spec.ts') ? [p] : [];
  });

// The Tailwind utility, or a declaration in an inline style; a comment that
// merely names the property has no colon after it.
const TEMPLATE_BLUR = /\bbackdrop-blur(?:-[a-z0-9]+)?\b|backdrop-filter\s*:\s*(?!none\b)/;

const templateSites = files(app)
  .filter((file) => TEMPLATE_BLUR.test(readFileSync(file, 'utf8')))
  .map((file) => file.slice(app.length + 1));

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

const rules = cssRules(readFileSync(join(__dirname, 'styles.css'), 'utf8'));
const cssSites = rules
  .filter((r) =>
    r.decls.some((d) => /^(?:-webkit-)?backdrop-filter:/.test(d) && !/:\s*none$/.test(d)),
  )
  .map((r) => `styles.css: ${r.prelude}`);

const found = [...new Set([...templateSites, ...cssSites])].sort();
const declared = Object.values(BLUR_SITES).flat().map(String).sort();

describe('backdrop blur policy (#1649)', () => {
  it('finds the blur sites it is meant to guard', () => {
    expect(found.length).toBeGreaterThanOrEqual(12);
    expect(templateSites.length).toBeGreaterThanOrEqual(8);
    expect(cssSites.length).toBeGreaterThanOrEqual(4);
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
