import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_GLOBS, configFiles, duplicateKeys } from './check-json-configs.js';

/**
 * `JSON.parse` accepts duplicate keys and silently keeps the LAST one, so this
 * whole class of damage is invisible to every other check in the repo.
 */
describe('duplicateKeys', () => {
  it('finds nothing in a clean document', () => {
    expect(duplicateKeys('{"a":1,"b":{"c":2}}')).toEqual([]);
  });

  /**
   * The real case that motivated this gate: merging the open PR queue produced
   * two `typecheck` entries, and the *second* won — silently discarding the
   * Angular-template check the PR adding it exists to introduce.
   */
  it('catches the merge-resolution duplicate that started this', () => {
    const merged = `{
      "scripts": {
        "typecheck": "tsc --build && bun run --filter @nicotind/web typecheck:template",
        "typecheck": "tsc --build"
      }
    }`;
    expect(duplicateKeys(merged)).toEqual(['scripts.typecheck']);
  });

  it('reports the full path so a nested duplicate is findable', () => {
    expect(duplicateKeys('{"a":{"b":{"c":1,"c":2}}}')).toEqual(['a.b.c']);
  });

  it('reports a top-level duplicate without a path prefix', () => {
    expect(duplicateKeys('{"name":"x","name":"y"}')).toEqual(['name']);
  });

  it('finds every duplicate, not just the first', () => {
    expect(duplicateKeys('{"a":1,"a":2,"b":3,"b":4}')).toEqual(['a', 'b']);
  });

  it('reports a key repeated three times once per extra occurrence', () => {
    expect(duplicateKeys('{"a":1,"a":2,"a":3}')).toEqual(['a', 'a']);
  });

  /** Same key under different parents is not a duplicate. */
  it('does not confuse sibling objects that share a key name', () => {
    expect(duplicateKeys('{"x":{"name":1},"y":{"name":2}}')).toEqual([]);
  });

  it('does not treat array elements as keyed members', () => {
    // Array indices arrive as "0","1",… per container; distinct arrays must not
    // collide with each other.
    expect(duplicateKeys('{"a":[1,2,3],"b":[4,5,6]}')).toEqual([]);
  });

  it('throws on genuinely malformed JSON rather than reporting no duplicates', () => {
    expect(() => duplicateKeys('{"a":}')).toThrow();
  });
});

describe('configFiles', () => {
  it('covers the workspace package.json files', () => {
    const files = configFiles();
    expect(files).toContain('package.json');
    expect(files).toContain('packages/api/package.json');
  });

  it('covers the i18n catalogs by pattern, whether or not they exist yet', () => {
    // A duplicate key in a catalog silently drops a translation. Asserted on
    // the glob rather than on resolved files so this holds on any branch —
    // the catalogs arrive with the i18n work (issue #236).
    expect(CONFIG_GLOBS).toContain('packages/web/public/i18n/*.json');
  });

  it('excludes tsconfigs, which are JSONC and would fail to parse', () => {
    expect(configFiles().some((f) => f.includes('tsconfig'))).toBe(false);
  });
});

describe('the real repo files', () => {
  it('are free of duplicate keys right now', () => {
    const root = resolve(import.meta.dir, '..');
    for (const file of configFiles(root)) {
      expect(duplicateKeys(readFileSync(resolve(root, file), 'utf8')), file).toEqual([]);
    }
  });
});
