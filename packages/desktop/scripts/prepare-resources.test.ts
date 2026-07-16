import { describe, expect, it } from 'bun:test';
import { buildBackendPackageJson, isLikelyBunBinary } from './prepare-resources.js';

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
