import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACCEPTED,
  ancestorKeys,
  auditShipped,
  parseBunLock,
  productionClosure,
  resolveKey,
  stripTrailingCommas,
  versionOf,
  type Advisory,
  type AuditReport,
  type BunLock,
} from './check-audit.js';

const ROOT = resolve(import.meta.dir, '..');

const adv = (severity: Advisory['severity'], range: string, title = 't'): Advisory => ({
  id: 1,
  url: 'https://example.invalid',
  title,
  severity,
  vulnerable_versions: range,
});

/**
 * A lockfile with every shape that matters:
 *  - a root prod dep and a root DEV dep
 *  - a workspace link whose own prod/dev deps must be split
 *  - a nested resolution that differs in version from the hoisted one
 *  - a package reachable ONLY through a devDependency
 */
const LOCK: BunLock = {
  workspaces: {
    '': {
      name: 'root',
      dependencies: { '@x/api': 'workspace:*', safe: '^2' },
      devDependencies: { toolchain: '^1' },
    },
    'packages/api': {
      name: '@x/api',
      dependencies: { shipped: '^1' },
      devDependencies: { devonly: '^1' },
    },
  },
  packages: {
    shipped: ['shipped@1.0.0', '', { dependencies: { nested: '^1' } }, 'sha512-x'],
    // The nested copy the walk must prefer over the hoisted one below.
    'shipped/nested': ['nested@1.0.0', '', {}, 'sha512-x'],
    nested: ['nested@9.9.9', '', {}, 'sha512-x'],
    safe: ['safe@2.0.0', '', {}, 'sha512-x'],
    toolchain: ['toolchain@1.0.0', '', { dependencies: { devonly: '^1' } }, 'sha512-x'],
    devonly: ['devonly@1.0.0', '', {}, 'sha512-x'],
  },
};

describe('stripTrailingCommas', () => {
  it('removes a trailing comma before } and ]', () => {
    expect(JSON.parse(stripTrailingCommas('{"a":[1,2,],}'))).toEqual({ a: [1, 2] });
  });

  it('leaves a comma inside a string alone', () => {
    // A blunt /,(\s*[}\]])/ would corrupt this. The lockfile it parses decides
    // what counts as vulnerable, so the parse has to be exact.
    const parsed = JSON.parse(stripTrailingCommas('{"a":"x, ]","b":"y, }",}'));
    expect(parsed).toEqual({ a: 'x, ]', b: 'y, }' });
  });

  it('respects escaped quotes', () => {
    expect(JSON.parse(stripTrailingCommas('{"a":"he said \\", }",}'))).toEqual({
      a: 'he said ", }',
    });
  });
});

describe('ancestorKeys', () => {
  it('treats a scoped name as one segment', () => {
    // '@angular/cli/listr2' is @angular/cli + listr2, not three segments.
    const packages = { '@angular/cli': [], '@angular/cli/listr2': [] } as Record<string, unknown[]>;
    expect(ancestorKeys('@angular/cli/listr2', packages)).toEqual(['@angular/cli']);
  });

  it('ignores a prefix that is not itself a package', () => {
    expect(ancestorKeys('@angular/cli/listr2', { '@angular/cli/listr2': [] })).toEqual([]);
  });
});

describe('versionOf', () => {
  it('reads a plain name', () => expect(versionOf(['hono@4.12.31'])).toBe('4.12.31'));
  it('reads a scoped name', () => expect(versionOf(['@a/b@1.2.3'])).toBe('1.2.3'));
  it('returns null when there is no spec', () => expect(versionOf([])).toBeNull());
});

describe('resolveKey', () => {
  it('prefers the nested copy over the hoisted one', () => {
    expect(resolveKey(LOCK, 'shipped', 'nested')).toBe('shipped/nested');
  });

  it('falls back to the hoisted copy', () => {
    expect(resolveKey(LOCK, 'safe', 'nested')).toBe('nested');
  });

  it('returns null for something not in the lockfile', () => {
    expect(resolveKey(LOCK, '', 'absent')).toBeNull();
  });
});

describe('productionClosure', () => {
  const closure = productionClosure(LOCK);
  const names = [...closure.values()].map((s) => s.name).sort();

  it('follows workspace links and their production dependencies', () => {
    expect(names).toContain('shipped');
    expect(names).toContain('safe');
  });

  it('never follows a devDependency', () => {
    // `toolchain` is a root devDep; `devonly` is reachable ONLY through a
    // devDependency (twice over). Following either is the whole bug.
    expect(names).not.toContain('toolchain');
    expect(names).not.toContain('devonly');
  });

  it('records the resolved version, not the hoisted one', () => {
    expect(closure.get('shipped/nested')?.version).toBe('1.0.0');
    expect(closure.has('nested')).toBe(false);
  });

  it('records the shortest path to each package', () => {
    expect(closure.get('shipped/nested')?.path).toEqual(['@x/api', 'shipped', 'nested']);
  });
});

describe('auditShipped — the two filters', () => {
  it('ignores an advisory against a package that does not ship', () => {
    // FILTER 1 red/green seam. `devonly` is genuinely vulnerable and genuinely
    // not shipped; `bun audit` alone cannot tell those apart.
    const report: AuditReport = { devonly: [adv('critical', '<2.0.0')] };
    expect(auditShipped(LOCK, report).blocking).toEqual([]);
  });

  it('ignores an advisory that does not match the resolved version', () => {
    // FILTER 2 red/green seam. The HOISTED nested@9.9.9 would match this range;
    // the copy that actually ships is 1.0.0, so nothing is wrong.
    const report: AuditReport = { nested: [adv('critical', '>=9.0.0')] };
    expect(auditShipped(LOCK, report).blocking).toEqual([]);
  });

  it('reports an advisory that both ships and matches', () => {
    const report: AuditReport = { nested: [adv('high', '<5.0.0', 'real')] };
    const { blocking } = auditShipped(LOCK, report);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.version).toBe('1.0.0');
    expect(blocking[0]!.path).toEqual(['@x/api', 'shipped', 'nested']);
  });

  it('counts the whole funnel, not just the survivors', () => {
    const report: AuditReport = {
      devonly: [adv('critical', '<2.0.0')],
      nested: [adv('high', '<5.0.0')],
    };
    const a = auditShipped(LOCK, report);
    expect(a.advisoryPackages).toBe(2);
    expect(a.advisoryCount).toBe(2);
    expect(a.inClosure).toEqual(['nested']);
    expect(a.closureSize).toBeGreaterThan(0);
  });
});

describe('auditShipped — severity threshold', () => {
  it('blocks at moderate and above', () => {
    const a = auditShipped(LOCK, { nested: [adv('moderate', '<5.0.0')] });
    expect(a.blocking).toHaveLength(1);
    expect(a.informational).toHaveLength(0);
  });

  it('reports a low without blocking', () => {
    const a = auditShipped(LOCK, { nested: [adv('low', '<5.0.0')] });
    expect(a.blocking).toHaveLength(0);
    expect(a.informational).toHaveLength(1);
  });
});

describe('auditShipped — ACCEPTED is checked both ways', () => {
  it('moves a matched advisory out of blocking', () => {
    const accepted = new Map([['nested@1.0.0', 'the vulnerable code path is unreachable here']]);
    const a = auditShipped(LOCK, { nested: [adv('high', '<5.0.0')] }, accepted);
    expect(a.blocking).toEqual([]);
    expect(a.accepted).toHaveLength(1);
    expect(a.staleAccepted).toEqual([]);
  });

  it('flags an entry that no longer matches anything', () => {
    // A one-way allowlist rots into a mute button. This is the inverted check.
    const accepted = new Map([['nested@1.0.0', 'reason']]);
    const a = auditShipped(LOCK, {}, accepted);
    expect(a.staleAccepted).toEqual(['nested@1.0.0']);
  });

  it('ships empty, so it cannot start life as a mute button', () => {
    expect([...ACCEPTED.keys()]).toEqual([]);
  });
});

describe('auditShipped — the denominator assertion', () => {
  it('reports a shipped package whose version cannot be read', () => {
    // Never silently skipped: unexamined must not look green. This is the shape
    // that let four gates in #612 report success over a subset.
    const broken: BunLock = {
      workspaces: { '': { name: 'root', dependencies: { mystery: '^1' } } },
      packages: { mystery: [] },
    };
    const a = auditShipped(broken, { mystery: [adv('high', '<9')] });
    expect(a.unresolved).toEqual(['mystery (lock key mystery)']);
    expect(a.blocking).toEqual([]);
  });
});

describe('the real bun.lock', () => {
  const lock = parseBunLock(readFileSync(resolve(ROOT, 'bun.lock'), 'utf8'));

  it('parses', () => {
    expect(Object.keys(lock.packages).length).toBeGreaterThan(1000);
  });

  it('yields a production closure far smaller than the lockfile', () => {
    // The entire premise: `bun audit` looks at ~2,500 packages, ~160 ship.
    const closure = productionClosure(lock);
    expect(closure.size).toBeGreaterThan(50);
    expect(closure.size).toBeLessThan(Object.keys(lock.packages).length / 4);
  });

  it('ships the API server and excludes the build toolchain', () => {
    const names = new Set([...productionClosure(lock).values()].map((s) => s.name));
    expect(names.has('hono')).toBe(true);
    expect(names.has('sharp')).toBe(true);
    // Angular, Storybook and Playwright build the app; they do not run in it.
    expect(names.has('@angular/cli')).toBe(false);
    expect(names.has('storybook')).toBe(false);
    expect(names.has('playwright')).toBe(false);
  });

  it('resolves a version for every shipped package', () => {
    // If this ever fails, the gate has gone partly blind and must say so.
    const missing = [...productionClosure(lock).values()].filter((s) => !s.version);
    expect(missing.map((s) => s.key)).toEqual([]);
  });
});
