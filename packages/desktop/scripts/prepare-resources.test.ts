import { describe, expect, it } from 'bun:test';
import {
  buildBackendPackageJson,
  isLikelyBunBinary,
  pinDependencies,
} from './prepare-resources.js';

describe('pinDependencies', () => {
  // #1174: the staged backend installs with no lockfile, so a surviving range
  // let the shipped desktop app resolve @sentry/core 10.75.0 while bun.lock —
  // and therefore every test and gate — pinned 10.67.0.
  const installed: Record<string, string> = {
    '@sentry/bun': '10.67.0',
    yaml: '2.9.1',
    hono: '4.6.3',
  };
  const resolve = (name: string) => installed[name] ?? null;

  it('rewrites a caret range to the installed version', () => {
    const { dependencies, unresolved } = pinDependencies({ '@sentry/bun': '^10.67.0' }, resolve);
    expect(dependencies).toEqual({ '@sentry/bun': '10.67.0' });
    expect(unresolved).toEqual([]);
  });

  it('pins every kind of range, not just carets', () => {
    const { dependencies } = pinDependencies(
      { yaml: '^2.9.0', hono: 'latest', '@sentry/bun': '>=10 <11' },
      resolve,
    );
    expect(dependencies).toEqual({ yaml: '2.9.1', hono: '4.6.3', '@sentry/bun': '10.67.0' });
  });

  it('leaves workspace: entries alone — they are symlinked, not resolved', () => {
    const { dependencies, unresolved } = pinDependencies(
      { '@nicotind/core': 'workspace:*', yaml: '^2.9.0' },
      resolve,
    );
    expect(dependencies['@nicotind/core']).toBe('workspace:*');
    expect(dependencies.yaml).toBe('2.9.1');
    expect(unresolved).toEqual([]);
  });

  it('reports an unresolvable dependency instead of silently keeping the range', () => {
    // Keeping the range is precisely the defect, so the caller must be able to
    // fail. A pinner that degrades quietly would pass this file's other tests.
    const { dependencies, unresolved } = pinDependencies({ ghost: '^1.0.0' }, resolve);
    expect(unresolved).toEqual(['ghost']);
    expect(dependencies.ghost).toBe('^1.0.0');
  });

  it('is empty-safe for a manifest with no dependencies', () => {
    expect(pinDependencies(undefined, resolve)).toEqual({ dependencies: {}, unresolved: [] });
  });

  it('leaves nothing floating when it resolves everything', () => {
    const { dependencies } = pinDependencies(
      { yaml: '^2.9.0', hono: '^4.0.0', '@nicotind/core': 'workspace:*' },
      resolve,
    );
    for (const [name, version] of Object.entries(dependencies)) {
      if (version.startsWith('workspace:')) continue;
      expect(version, `${name} is still a range`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe('buildBackendPackageJson', () => {
  it('turns workspace package names into workspace:* deps', () => {
    const pkg = buildBackendPackageJson({}, ['@nicotind/core', '@nicotind/api'], '0.1.0');
    expect(pkg.dependencies).toEqual({
      '@nicotind/core': 'workspace:*',
      '@nicotind/api': 'workspace:*',
    });
  });

  it('keeps external root dependencies verbatim', () => {
    const pkg = buildBackendPackageJson({ yaml: '^2.9.0' }, [], '0.1.0');
    expect(pkg.dependencies).toEqual({ yaml: '^2.9.0' });
  });

  it('drops @nicotind/* entries from the root deps (re-derived from workspacePackageNames instead)', () => {
    const pkg = buildBackendPackageJson(
      { '@nicotind/api': 'workspace:*', yaml: '^2.9.0' },
      ['@nicotind/api'],
      '0.1.0',
    );
    // Only one @nicotind/api entry, not duplicated/conflicting.
    expect(pkg.dependencies).toEqual({ yaml: '^2.9.0', '@nicotind/api': 'workspace:*' });
  });

  it('handles undefined root dependencies', () => {
    const pkg = buildBackendPackageJson(undefined, ['@nicotind/core'], '0.1.0');
    expect(pkg.dependencies).toEqual({ '@nicotind/core': 'workspace:*' });
  });

  it('always points workspaces at packages/* and marks the tree private', () => {
    const pkg = buildBackendPackageJson({}, [], '0.1.0');
    expect(pkg.workspaces).toEqual(['packages/*']);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.name).toBe('nicotind-backend');
  });

  it('uses the provided version in the synthesized backend package.json', () => {
    const pkg = buildBackendPackageJson({}, [], '1.2.3');
    expect(pkg.version).toBe('1.2.3');
  });

  it('passes through the real version from the repo root (not 0.0.0)', () => {
    const pkg = buildBackendPackageJson({}, ['@nicotind/api'], '0.1.204');
    expect(pkg.version).toBe('0.1.204');
  });
});

describe('isLikelyBunBinary', () => {
  it('accepts a plain bun path', () => {
    expect(isLikelyBunBinary('/home/user/.bun/bin/bun')).toBe(true);
  });

  it('accepts bun.exe on Windows', () => {
    expect(isLikelyBunBinary('C:\\Users\\me\\bun.exe')).toBe(true);
  });

  it('rejects node', () => {
    expect(isLikelyBunBinary('/usr/bin/node')).toBe(false);
  });

  it('rejects a path not ending in bun/bun.exe', () => {
    expect(isLikelyBunBinary('/opt/bundler/thing')).toBe(false);
  });
});
