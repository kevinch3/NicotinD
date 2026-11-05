import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBunLock, type BunLock } from './check-audit.js';
import { checkOptionalDeps } from './check-lockfile-platforms.js';

const realLock = (): BunLock =>
  parseBunLock(readFileSync(resolve(import.meta.dir, '..', 'bun.lock'), 'utf8'));

const lockOf = (packages: BunLock['packages']): BunLock => ({ workspaces: {}, packages });

describe('checkOptionalDeps', () => {
  it('passes when every optional binary has an entry', () => {
    const report = checkOptionalDeps(
      lockOf({
        tool: ['tool@1.0.0', '', { optionalDependencies: { '@tool/linux-x64': '1.0.0' } }, 'h'],
        '@tool/linux-x64': ['@tool/linux-x64@1.0.0', '', {}, 'h'],
      }),
    );
    expect(report).toEqual({ parents: 1, edges: 1, problems: [] });
  });

  it('fails on a dropped platform binary', () => {
    const report = checkOptionalDeps(
      lockOf({
        tool: [
          'tool@1.0.0',
          '',
          { optionalDependencies: { '@tool/linux-x64': '1.0.0', '@tool/darwin-arm64': '1.0.0' } },
          'h',
        ],
        '@tool/linux-x64': ['@tool/linux-x64@1.0.0', '', {}, 'h'],
      }),
    );
    expect(report.problems).toEqual([
      'tool lists @tool/darwin-arm64@1.0.0, which has no lock entry',
    ]);
  });

  it('prefers the nested copy, as bun resolves it', () => {
    const report = checkOptionalDeps(
      lockOf({
        parent: ['parent@1.0.0', '', {}, 'h'],
        'parent/tool': ['tool@2.0.0', '', { optionalDependencies: { '@tool/bin': '2.0.0' } }, 'h'],
        'parent/tool/@tool/bin': ['@tool/bin@2.0.0', '', {}, 'h'],
        '@tool/bin': ['@tool/bin@1.0.0', '', {}, 'h'],
      }),
    );
    expect(report.problems).toEqual([]);
  });

  it('fails when only a hoisted copy of the wrong version is left', () => {
    const report = checkOptionalDeps(
      lockOf({
        parent: ['parent@1.0.0', '', {}, 'h'],
        'parent/tool': ['tool@2.0.0', '', { optionalDependencies: { '@tool/bin': '2.0.0' } }, 'h'],
        '@tool/bin': ['@tool/bin@1.0.0', '', {}, 'h'],
      }),
    );
    expect(report.problems).toEqual(['parent/tool wants @tool/bin@2.0.0, but @tool/bin is 1.0.0']);
  });
});

describe('the real bun.lock', () => {
  it('has a denominator, and no problems', () => {
    const report = checkOptionalDeps(realLock());
    expect(report.edges).toBeGreaterThan(100);
    expect(report.problems).toEqual([]);
  });

  it('catches the #1533 shape: every other platform stripped', () => {
    const lock = realLock();
    const platform = /(darwin|win32|freebsd|android|arm64|arm-|musl)/;
    for (const key of Object.keys(lock.packages)) {
      const spec = lock.packages[key]![0] as string;
      if (spec.startsWith('@') && platform.test(spec)) delete lock.packages[key];
    }
    expect(checkOptionalDeps(lock).problems.length).toBeGreaterThan(50);
  });
});
