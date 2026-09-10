import { describe, expect, it } from 'bun:test';
import { findDrift, versionFromRealpath } from './check-node-modules-drift.js';
import type { BunLock } from './check-audit.js';

describe('versionFromRealpath', () => {
  it('reads the version out of an unscoped store entry', () => {
    expect(
      versionFromRealpath('hono', '/repo/node_modules/.bun/hono@4.13.3/node_modules/hono'),
    ).toBe('4.13.3');
  });

  it('reads the version out of a scoped store entry (/ stored as +)', () => {
    expect(
      versionFromRealpath(
        '@hono/zod-openapi',
        '/repo/node_modules/.bun/@hono+zod-openapi@1.6.1/node_modules/@hono/zod-openapi',
      ),
    ).toBe('1.6.1');
  });

  it('returns null for a path that never touches the .bun store', () => {
    // A workspace-to-workspace link resolves straight into packages/core/src.
    expect(versionFromRealpath('@nicotind/core', '/repo/packages/core/src/index.ts')).toBeNull();
  });
});

describe('findDrift', () => {
  // Mirrors #1088: packages/api pins hono ^4.13.5, bun.lock hoists it to
  // 4.13.7, but the store still has an older 4.13.3 lying around too.
  const LOCK: BunLock = {
    workspaces: {
      '': {
        name: 'nicotind',
        dependencies: { '@x/api': 'workspace:*' },
      },
      'packages/api': {
        name: '@x/api',
        dependencies: { hono: '^4.13.5' },
        devDependencies: { '@types/hono-nope': '^1' }, // resolves to nothing, must be skipped
      },
    },
    packages: {
      hono: ['hono@4.13.7', '', {}, 'sha512-x'],
    },
  };

  it('flags a workspace dependency linked to a version bun.lock does not pin', () => {
    const findings = findDrift(LOCK, (dir, name) => {
      if (dir === 'packages/api' && name === 'hono') return '4.13.3'; // the stale store entry
      return '4.13.7';
    });
    expect(findings).toEqual([
      { workspace: '@x/api', name: 'hono', lockedVersion: '4.13.7', linkedVersion: '4.13.3' },
    ]);
  });

  it('finds nothing when every linked version matches the lock', () => {
    const findings = findDrift(LOCK, () => '4.13.7');
    expect(findings).toEqual([]);
  });

  it('never flags a workspace:* link even if resolveLinked reports a version for it', () => {
    const findings = findDrift(LOCK, (dir, name) => {
      if (name === '@x/api') return '9.9.9'; // must never be looked up as a store package
      return '4.13.7';
    });
    expect(findings).toEqual([]);
  });

  it('skips a dependency resolveLinked cannot resolve on disk (not installed here)', () => {
    const findings = findDrift(LOCK, () => null);
    expect(findings).toEqual([]);
  });
});
