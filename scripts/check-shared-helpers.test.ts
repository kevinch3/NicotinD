import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { findLocalDeclarations, SHARED_HELPERS } from './check-shared-helpers.js';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

describe('findLocalDeclarations', () => {
  it('flags a plain function declaration', () => {
    const hits = findLocalDeclarations(
      'function expandHome(p: string) {\n  return p;\n}',
      'expandHome',
    );
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  it('flags an exported function declaration', () => {
    expect(findLocalDeclarations('export function expandHome(p) {}', 'expandHome')).toHaveLength(1);
  });

  it('flags a const arrow declaration', () => {
    expect(findLocalDeclarations('const expandHome = (p) => p;', 'expandHome')).toHaveLength(1);
    expect(findLocalDeclarations('export const expandHome = (p) => p;', 'expandHome')).toHaveLength(
      1,
    );
  });

  it('flags an indented declaration (nested in a block)', () => {
    expect(findLocalDeclarations('  function expandHome(p) {}', 'expandHome')).toHaveLength(1);
  });

  // The whole point: importing and calling must stay silent, or the gate cries
  // wolf on all 30 legitimate consumers.
  it('ignores an import of the shared helper', () => {
    expect(
      findLocalDeclarations("import { expandHome } from '@nicotind/core';", 'expandHome'),
    ).toHaveLength(0);
  });

  it('ignores call sites', () => {
    const src = 'const dataDir = expandHome(raw);\nreturn expandHome(musicDir);';
    expect(findLocalDeclarations(src, 'expandHome')).toHaveLength(0);
  });

  it('ignores a mention in a comment', () => {
    expect(
      findLocalDeclarations(' * why: expandHome was copy-pasted into 32 files', 'expandHome'),
    ).toHaveLength(0);
  });

  it('ignores a different name that merely contains the helper name', () => {
    expect(findLocalDeclarations('function expandHomeDir(p) {}', 'expandHomeDir').length).toBe(1);
    expect(findLocalDeclarations('function expandHomeDir(p) {}', 'expandHome')).toHaveLength(0);
  });

  it('reports every declaration when a file has more than one', () => {
    const src = 'function expandHome(a) {}\nconst x = 1;\nconst expandHome = (b) => b;';
    expect(findLocalDeclarations(src, 'expandHome').map((h) => h.line)).toEqual([1, 3]);
  });
});

describe('SHARED_HELPERS registry', () => {
  it('points every entry at a canonical module that exists', () => {
    for (const h of SHARED_HELPERS) {
      expect(existsSync(resolve(repoRoot, h.canonical))).toBe(true);
    }
  });

  it('actually exports the named helper from its canonical module', async () => {
    // Not `typeof === 'function'`: a shared **constant** drifts just as readily,
    // and more quietly. `AUDIO_EXTENSIONS` existed six times with six different
    // memberships until #845 — the registry has to be able to guard a Set.
    for (const h of SHARED_HELPERS) {
      const mod = (await import(resolve(repoRoot, h.canonical))) as Record<string, unknown>;
      expect({ name: h.name, exported: mod[h.name] !== undefined }).toEqual({
        name: h.name,
        exported: true,
      });
    }
  });
});
