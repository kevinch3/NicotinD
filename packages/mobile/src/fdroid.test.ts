import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NON_FREE_PLUGINS, fdroidAppId, fdroidIncludePlugins } from './fdroid.js';

// Read rather than `import … with { type: 'json' }`: tsconfig's `module` is
// ES2022, which rejects import attributes (`bun test` type-checks nothing, so
// that only surfaces in CI's `tsc --build`).
const pkg: { dependencies: Record<string, string>; devDependencies: Record<string, string> } =
  JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));

describe('fdroidIncludePlugins', () => {
  it('drops every non-free plugin', () => {
    const included = fdroidIncludePlugins({
      '@capacitor/barcode-scanner': '^1',
      '@nicotind/capacitor-apk-update': 'workspace:*',
      '@capacitor/app': '^6',
    });
    expect(included).toEqual(['@capacitor/app']);
  });

  it('includes devDependencies too — Capacitor scans both by default', () => {
    const included = fdroidIncludePlugins({ '@capacitor/app': '^6' }, { '@capacitor/cli': '^6' });
    expect(included).toEqual(['@capacitor/app', '@capacitor/cli']);
  });

  it('includes a plugin added later without being named here', () => {
    // The allowlist REPLACES Capacitor's dependency scan, so a hand-written
    // keep-list would omit new plugins and ship an F-Droid-only regression.
    const included = fdroidIncludePlugins({ '@nicotind/capacitor-brand-new': 'workspace:*' });
    expect(included).toContain('@nicotind/capacitor-brand-new');
  });

  it('is empty for an empty dependency set rather than throwing', () => {
    expect(fdroidIncludePlugins()).toEqual([]);
  });
});

describe('NON_FREE_PLUGINS', () => {
  it('names only packages this app actually depends on', () => {
    // A renamed or removed plugin would leave a dead exclusion behind, and the
    // allowlist would then look correct while excluding nothing.
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const name of Object.keys(NON_FREE_PLUGINS)) {
      expect(deps).toContain(name);
    }
  });

  it('actually removes them from the real dependency set', () => {
    const included = fdroidIncludePlugins(pkg.dependencies, pkg.devDependencies);
    for (const name of Object.keys(NON_FREE_PLUGINS)) {
      expect(included).not.toContain(name);
    }
    expect(included).toContain('@jofr/capacitor-media-session');
    expect(included).toContain('@nicotind/capacitor-tv-channels');
  });
});

describe('fdroidAppId', () => {
  it('suffixes the TV entry so it is a distinct F-Droid app', () => {
    expect(fdroidAppId('ar.kevinroberts.nicotind', true)).toBe('ar.kevinroberts.nicotind.tv');
  });

  it('leaves the phone entry on the base id', () => {
    expect(fdroidAppId('ar.kevinroberts.nicotind', false)).toBe('ar.kevinroberts.nicotind');
  });
});
