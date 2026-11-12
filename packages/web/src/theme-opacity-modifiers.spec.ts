import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tailwind v4 resolves a `/NN` opacity modifier only for a colour registered in
 * `@theme`. A name that exists only as a static class (`.bg-theme-surface-2`)
 * makes `bg-theme-surface-2/90` emit no rule at all — silently. That left the
 * mosaic's view switch transparent and 23 hover/background states inert
 * (#1640), and before that the review inbox's buttons (#591). This reads every
 * template and component and fails on a modifier whose colour is unregistered.
 */
const src = join(__dirname, 'app');
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const registered = new Set([...themeBlock.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));
const utilities = new Set([...css.matchAll(/@utility\s+([a-z0-9-]+)/g)].map((m) => m[1]));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(html|ts)$/.test(name) && !name.endsWith('.spec.ts') ? [p] : [];
  });

const uses = files(src).flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/-((?:theme|status)-[a-z0-9-]+)\/\d+\b/g)].map((m) => ({
    color: m[1],
    file: file.slice(src.length + 1),
  })),
);

/**
 * The same silence for variants (#1846): `hover:text-theme-primary` emitted no
 * rule in 46 files while `text-theme-primary` existed only as a static class.
 * A variant resolves for an `@theme` colour or an `@utility`, nothing else.
 */
const PROPS =
  'bg|text|border|ring|divide|outline|fill|stroke|placeholder|from|to|via|decoration|accent|caret|shadow';
const variantUses = files(src).flatMap((file) =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      new RegExp(
        `(?<![\\w-])(?:[a-z-]+:)+((?:${PROPS})-((?:theme|status)(?:-[a-z0-9]+)*))(?![\\w/-])`,
        'g',
      ),
    ),
  ].map((m) => ({ utility: m[1]!, color: m[2]!, file: file.slice(src.length + 1) })),
);

describe('variant theme utilities resolve (#1846)', () => {
  it('finds the variants it is meant to guard', () => {
    expect(variantUses.length).toBeGreaterThan(100);
  });

  it('every hover:/focus:/… theme utility is an @theme colour or an @utility', () => {
    const inert = variantUses
      .filter((u) => !registered.has(u.color) && !utilities.has(u.utility))
      .map((u) => `${u.utility} in ${u.file}`);
    expect([...new Set(inert)]).toEqual([]);
  });
});

describe('opacity-modified theme colours are registered in @theme', () => {
  it('finds the modifiers it is meant to guard', () => {
    expect(uses.length).toBeGreaterThan(50);
    expect(registered.has('theme-surface')).toBe(true);
  });

  it('every theme/status colour used with /NN is a registered @theme colour', () => {
    const missing = uses
      .filter((u) => !registered.has(u.color))
      .map((u) => `${u.color} in ${u.file}`);
    expect([...new Set(missing)]).toEqual([]);
  });
});
