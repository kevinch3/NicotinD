import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// #1686: a control that rests on `surface-2` hovers to `surface-3`, the level
// above it. `hover:bg-theme-hover` is a translucent `surface-2`, so on a
// `surface-2` control it reads as the control fading toward the page instead of
// lifting. This fails any class list that pairs the two.
const APP = join(__dirname, 'app');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    if (!/\.(html|ts)$/.test(name) || /\.(spec|stories)\.ts$/.test(name)) return [];
    return [p];
  });
}

const RESTS_ON_SURFACE_2 = /(?<![\w:.-])bg-theme-surface-2(?![\w/-])/;
const FADES_ON_HOVER = /(?<![\w-])hover:bg-theme-hover(?![\w/-])/;

/** One class list: a quoted run with no quote of its own kind inside it. */
const classLists = (text: string): string[] => text.match(/'[^'\n]*'|"[^"\n]*"/g) ?? [];

function offenders(text: string): string[] {
  return classLists(text).filter((list) => {
    // A double-quoted attribute may hold single-quoted branches of a ternary;
    // those are judged on their own, so skip the wrapper.
    if (list.startsWith('"') && list.includes("'")) return false;
    return RESTS_ON_SURFACE_2.test(list) && FADES_ON_HOVER.test(list);
  });
}

describe('a raised control hovers to surface-3 (#1686)', () => {
  it('no class list pairs bg-theme-surface-2 with hover:bg-theme-hover', () => {
    const files = sources(APP);
    expect(files.length, 'sources swept').toBeGreaterThan(300);
    const found = files.flatMap((p) =>
      offenders(readFileSync(p, 'utf8')).map((list) => `${relative(APP, p)}: ${list}`),
    );
    expect(found).toEqual([]);
  });

  it('the rule is in use, so the sweep is looking at something', () => {
    const uses = sources(APP).filter((p) =>
      readFileSync(p, 'utf8').includes('hover:bg-theme-surface-3'),
    );
    expect(uses.length).toBeGreaterThan(20);
  });

  it('the patterns catch what they are for', () => {
    expect(offenders(`class="px-2 bg-theme-surface-2 hover:bg-theme-hover"`)).toHaveLength(1);
    expect(offenders(`'bg-theme-surface-2 hover:bg-theme-hover'`)).toHaveLength(1);
    // The level itself, a conditional binding, and the two in different branches are fine.
    expect(offenders(`class="bg-theme-surface-2 hover:bg-theme-surface-3"`)).toEqual([]);
    expect(offenders(`[class.bg-theme-surface-2]="on" class="hover:bg-theme-hover"`)).toEqual([]);
    expect(offenders(`[class]="on ? 'bg-theme-surface-2' : 'hover:bg-theme-hover'"`)).toEqual([]);
    expect(offenders(`class="bg-theme-surface-2/90 hover:bg-theme-hover"`)).toEqual([]);
  });
});
