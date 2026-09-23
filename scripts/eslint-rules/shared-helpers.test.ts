import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHARED_HELPERS } from './shared-helpers.js';
import { lintReaches, lintWith, repoRoot, ruleIsOn } from './test-support.js';

const FILE = 'packages/api/src/services/some-consumer.ts';
const lines = (code: string, file = FILE) =>
  lintWith('shared-helpers', code, file).map((m) => m.line);

describe('nicotind/shared-helpers — flags a local copy', () => {
  it('flags a plain function declaration', () => {
    expect(lines('function expandHome(p: string) {\n  return p;\n}')).toEqual([1]);
  });

  it('flags an exported function declaration', () => {
    expect(lines('export function expandHome(p) { return p; }')).toEqual([1]);
  });

  it('flags a const arrow declaration, typed or not', () => {
    expect(lines('const expandHome = (p) => p;')).toEqual([1]);
    expect(lines('export const expandHome: (p: string) => string = (p) => p;')).toEqual([1]);
  });

  it('flags a declaration nested in a block', () => {
    expect(lines('function outer() {\n  function expandHome(p) { return p; }\n}')).toEqual([2]);
  });

  it('flags a let copy, which the line regex it replaced could not see', () => {
    expect(lines('let expandHome = (p) => p;')).toEqual([1]);
  });

  it('reports every declaration when a file has more than one', () => {
    const src = 'function expandHome(a) { return a; }\nconst x = 1;\nconst tokenize = (b) => b;';
    expect(lines(src)).toEqual([1, 3]);
  });
});

describe('nicotind/shared-helpers — stays quiet on legitimate use', () => {
  // Importing and calling must stay silent, or the rule cries wolf on every consumer.
  it('ignores an import and a call site', () => {
    expect(lines("import { expandHome } from '@nicotind/core';\nexpandHome('~');")).toEqual([]);
  });

  it('ignores a mention in a comment', () => {
    expect(lines('// expandHome was copy-pasted into 32 files\nconst y = 1;')).toEqual([]);
  });

  it('ignores a different name that merely contains the helper name', () => {
    expect(lines('function expandHomeDir(p) { return p; }')).toEqual([]);
  });

  it('allows the canonical module to declare its own helper', () => {
    const expandHome = SHARED_HELPERS.find((h) => h.name === 'expandHome')!;
    expect(lines('export function expandHome(p) { return p; }', expandHome.canonical)).toEqual([]);
  });
});

describe('SHARED_HELPERS registry', () => {
  it('points every entry at a canonical module that exists', () => {
    for (const h of SHARED_HELPERS) expect(existsSync(resolve(repoRoot, h.canonical))).toBe(true);
  });

  it('actually exports the named helper from its canonical module', async () => {
    // Not `typeof === 'function'`: a shared constant drifts just as readily. AUDIO_EXTENSIONS
    // existed six times with six memberships until #845.
    for (const h of SHARED_HELPERS) {
      const mod = (await import(resolve(repoRoot, h.canonical))) as Record<string, unknown>;
      expect({ name: h.name, exported: mod[h.name] !== undefined }).toEqual({
        name: h.name,
        exported: true,
      });
    }
  });
});

// The denominator. A rule that silently matches nothing reports the same clean run as one
// that checked everything, so each entry is proven against the declaration shape it
// actually has in the repo, and against the lint command actually reaching that code.
describe('the rule watches every registered helper', () => {
  it("fires on each canonical module's real declaration when it appears anywhere else", () => {
    for (const h of SHARED_HELPERS) {
      const source = readFileSync(resolve(repoRoot, h.canonical), 'utf8');
      const elsewhere = h.canonical.replace(/[^/]+$/, '__copy__$&');
      const hits = lintWith('shared-helpers', source, elsewhere).filter((m) =>
        m.message.startsWith(`\`${h.name}\``),
      );
      expect({ name: h.name, fires: hits.length > 0 }).toEqual({ name: h.name, fires: true });
    }
  });

  it('is switched on, and reached by `bun run lint`, in every tree a helper lives in', async () => {
    for (const h of SHARED_HELPERS) {
      const probe = h.canonical.replace(/[^/]+$/, '__copy__$&');
      expect({ file: probe, on: await ruleIsOn('nicotind/shared-helpers', probe) }).toEqual({
        file: probe,
        on: true,
      });
      expect({ file: probe, reached: await lintReaches(probe) }).toEqual({
        file: probe,
        reached: true,
      });
    }
  });
});
