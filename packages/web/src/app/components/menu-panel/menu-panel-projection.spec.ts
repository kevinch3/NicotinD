import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Drift guard: every `<app-menu-panel>` must project a trigger with the literal
 * `menuTrigger` attribute.
 *
 * `MenuPanelComponent` selects strictly on `[menuTrigger]` / `[menuPanel]` and has
 * no catch-all `<ng-content>`, so content carrying any other attribute is dropped
 * **silently** — it renders nowhere, and nothing in typecheck, lint, Storybook or a
 * component's own spec notices. `ArtistImageMenuComponent` shipped with `trigger`
 * instead of `menuTrigger`, which made the artist-photo edit control invisible on
 * the artist page and on every Artists-grid tile while its 14-case suite stayed
 * green (those cases drove the class, never the DOM).
 *
 * Same shape as `pages/page-shell.spec.ts`: read the templates off disk and fail on
 * the pattern, so call site #3 can't reintroduce it.
 */
const APP_DIR = join(__dirname, '../..');
const OPEN = '<app-menu-panel';
const CLOSE = '</app-menu-panel>';

function templateFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) templateFiles(full, out);
    // Shipped call sites only. `.ts` is included for inline templates, but specs
    // and stories are excluded: they compose markup out of interpolated
    // constants (`menu-panel.stories.ts` builds its body from a shared `ITEMS`),
    // so a literal scan reads that as a missing slot — and this file's own
    // string literals would otherwise match too.
    else if (
      (entry.endsWith('.html') || entry.endsWith('.ts')) &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.stories.ts')
    )
      out.push(full);
  }
  return out;
}

/** Every `<app-menu-panel>…</app-menu-panel>` block, as `file:index` → body. */
function menuPanelBlocks(): Array<{ where: string; body: string }> {
  const blocks: Array<{ where: string; body: string }> = [];
  for (const file of templateFiles(APP_DIR)) {
    const src = readFileSync(file, 'utf8');
    let from = src.indexOf(OPEN);
    let n = 0;
    while (from !== -1) {
      const end = src.indexOf(CLOSE, from);
      // An unclosed tag is its own bug; take the rest of the file so it still fails
      // loudly here rather than being skipped.
      const body = src.slice(from, end === -1 ? src.length : end);
      blocks.push({ where: `${relative(APP_DIR, file)}#${n}`, body });
      from = src.indexOf(OPEN, from + OPEN.length);
      n += 1;
    }
  }
  return blocks;
}

describe('MenuPanelComponent projection contract', () => {
  const blocks = menuPanelBlocks();

  it('finds the known call sites, so a broken walker cannot pass vacuously', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it('every <app-menu-panel> projects a [menuTrigger]', () => {
    const missing = blocks.filter((b) => !/\bmenuTrigger\b/.test(b.body)).map((b) => b.where);
    expect(missing).toEqual([]);
  });

  it('every <app-menu-panel> projects a [menuPanel] body', () => {
    const missing = blocks.filter((b) => !/\bmenuPanel\b/.test(b.body)).map((b) => b.where);
    expect(missing).toEqual([]);
  });
});
