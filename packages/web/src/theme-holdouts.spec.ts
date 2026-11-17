import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A hardcoded `zinc`/`indigo` utility ignores the active preset: Search's input
 * was a black slab on Daylight, and its empty state read 1.6:1 on the dark
 * presets (#1685, docs/theme-audit.md). Every template and component must use
 * theme tokens instead, except the surfaces that are deliberately fixed-dark.
 */
const src = join(__dirname, 'app');

/** Deliberate exceptions, each with its reason (docs/web-ui.md "Theme System"). */
const ALLOWED: Record<string, string> = {
  // A hue set for gradients, not a neutral standing in for a token.
  'lib/vibe-presets.ts': 'decorative gradient hues',
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(html|ts)$/.test(name) && !/\.(spec|stories)\.ts$/.test(name) ? [p] : [];
  });

const HOLDOUT =
  /(?<![\w-])(?:[a-z-]+:)*[a-z]+(?:-[a-z]+)*-(?:zinc|indigo)-\d{2,3}(?:\/\d+)?(?![\w-])/g;

const found = files(src).flatMap((file) => {
  const rel = file.slice(src.length + 1);
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, i) => {
      // A comment that names an old class is history, not a use.
      if (rel.endsWith('.ts') && /^\s*(\/\/|\*|\/\*)/.test(line)) return [];
      return [...line.matchAll(HOLDOUT)].map((m) => ({ rel, line: i + 1, cls: m[0] }));
    });
});

describe('no hardcoded zinc/indigo outside the fixed-dark surfaces (#1685)', () => {
  it('scans the files it is meant to guard', () => {
    expect(found.some((f) => f.rel in ALLOWED)).toBe(true);
  });

  it('every zinc/indigo utility sits in an allowed file', () => {
    const stray = found
      .filter((f) => !(f.rel in ALLOWED))
      .map((f) => `${f.rel}:${f.line} ${f.cls}`);
    expect(stray).toEqual([]);
  });

  it('every allowed file still needs its exception', () => {
    const unused = Object.keys(ALLOWED).filter((rel) => !found.some((f) => f.rel === rel));
    expect(unused).toEqual([]);
  });
});

// Error text is `text-status-error`, which each preset sets for its own
// surfaces. A hardcoded `text-red-400` read 2.88:1 on Daylight's white card
// (found by the Storybook gate's light-preset scan, #1686).
describe('no hardcoded red text outside the fixed-dark surfaces (#1686)', () => {
  const RED_TEXT = /(?<![\w-])(?:[a-z-]+:)*!?text-red-\d{2,3}(?![\w/-])/g;
  /** Text over a surface that is dark on every preset. */
  const RED_ALLOWED = new Set([
    ...Object.keys(ALLOWED),
    'components/now-playing/now-playing-karaoke-fullscreen/now-playing-karaoke-fullscreen.component.html',
  ]);

  it('every red text utility sits on a fixed-dark surface', () => {
    const stray = files(src).flatMap((file) => {
      const rel = file.slice(src.length + 1);
      if (RED_ALLOWED.has(rel)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => [...line.matchAll(RED_TEXT)].map((m) => `${rel}:${i + 1} ${m[0]}`));
    });
    expect(stray).toEqual([]);
  });

  it('the pattern catches the forms that were in use', () => {
    const hit = (s: string) => [...s.matchAll(RED_TEXT)].map((m) => m[0]);
    expect(hit('class="text-red-400 text-sm"')).toEqual(['text-red-400']);
    expect(hit('hover:!text-red-400')).toEqual(['hover:!text-red-400']);
    expect(hit('[class.text-red-400]="x"')).toEqual(['text-red-400']);
    expect(hit('text-status-error bg-red-500')).toEqual([]);
  });
});
