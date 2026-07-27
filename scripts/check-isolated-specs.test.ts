import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSpecs, isGreen } from './check-isolated-specs.js';

describe('isGreen', () => {
  it('reads a bun run as green only on an explicit 0 fail', () => {
    expect(isGreen(' 12 pass\n 0 fail\n', 'bun')).toBe(true);
    expect(isGreen(' 11 pass\n 1 fail\n', 'bun')).toBe(false);
  });

  it('does not call a bun run green just because something passed', () => {
    // A crash before the summary must not read as success.
    expect(isGreen('SyntaxError: unexpected token', 'bun')).toBe(false);
  });

  it('reads a vitest run from its Tests summary', () => {
    expect(isGreen('  Tests  16 passed (16)', 'vitest')).toBe(true);
    expect(isGreen('  Tests  1 failed | 15 passed (16)', 'vitest')).toBe(false);
  });
});

describe('collectSpecs', () => {
  it('finds specs recursively and skips build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'iso-'));
    mkdirSync(join(root, 'nested/deep'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'a.test.ts'), '');
    writeFileSync(join(root, 'nested/deep/b.test.ts'), '');
    writeFileSync(join(root, 'nested/notaspec.ts'), '');
    writeFileSync(join(root, 'node_modules/c.test.ts'), '');
    writeFileSync(join(root, 'dist/d.test.ts'), '');

    const found = collectSpecs(root, '.test.ts')
      .map((p) => p.slice(root.length + 1))
      .sort();
    expect(found).toEqual(['a.test.ts', 'nested/deep/b.test.ts']);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns nothing for a missing directory rather than throwing', () => {
    expect(collectSpecs('/no/such/dir', '.test.ts')).toEqual([]);
  });
});
