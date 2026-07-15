import { describe, expect, it } from 'bun:test';
import { buildBackendPackageJson, isLikelyBunBinary } from './prepare-resources.js';

describe('buildBackendPackageJson', () => {
  it('turns workspace package names into workspace:* deps', () => {
    const pkg = buildBackendPackageJson({}, ['@nicotind/core', '@nicotind/api']);
    expect(pkg.dependencies).toEqual({
      '@nicotind/core': 'workspace:*',
      '@nicotind/api': 'workspace:*',
    });
  });

  it('keeps external root dependencies verbatim', () => {
    const pkg = buildBackendPackageJson({ yaml: '^2.9.0' }, []);
    expect(pkg.dependencies).toEqual({ yaml: '^2.9.0' });
  });

  it('drops @nicotind/* entries from the root deps (re-derived from workspacePackageNames instead)', () => {
    const pkg = buildBackendPackageJson(
      { '@nicotind/api': 'workspace:*', yaml: '^2.9.0' },
      ['@nicotind/api'],
    );
    // Only one @nicotind/api entry, not duplicated/conflicting.
    expect(pkg.dependencies).toEqual({ yaml: '^2.9.0', '@nicotind/api': 'workspace:*' });
  });

  it('handles undefined root dependencies', () => {
    const pkg = buildBackendPackageJson(undefined, ['@nicotind/core']);
    expect(pkg.dependencies).toEqual({ '@nicotind/core': 'workspace:*' });
  });

  it('always points workspaces at packages/* and marks the tree private', () => {
    const pkg = buildBackendPackageJson({}, []);
    expect(pkg.workspaces).toEqual(['packages/*']);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.name).toBe('nicotind-backend');
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
