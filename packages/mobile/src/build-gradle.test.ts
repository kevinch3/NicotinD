import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { androidVersion } from './version.js';
import { readFdroidVersions } from './android-version.js';

/**
 * `build.gradle` carries the Android version as LITERALS, and this pins them to
 * the monorepo's `package.json`.
 *
 * They are literals because F-Droid's `checkupdates` greps this file with its
 * own regex to decide what a tag contains — it cannot evaluate Groovy. The file
 * used to compute the version, which F-Droid read as no version at all, so
 * `AutoUpdateMode: Version` would have quietly stopped offering new releases.
 *
 * `bun run release` keeps them current (`.versionrc.json` postchangelog →
 * `packages/mobile/scripts/android-version.ts`). This test is what catches the
 * hook silently not running: nothing else would, because a stale literal builds
 * and ships perfectly well — it just publishes the wrong version forever.
 */
const gradle = readFileSync(join(import.meta.dir, '..', 'android', 'app', 'build.gradle'), 'utf8');
const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../..', 'package.json'), 'utf8')) as {
  version: string;
};

describe('build.gradle — version literals', () => {
  it('matches the monorepo version', () => {
    const { versionCode, versionName } = androidVersion(pkg.version);
    const found = readFdroidVersions(gradle);
    expect(found.codes).toEqual([String(versionCode)]);
    expect(found.names).toEqual([versionName]);
  });

  it('exposes exactly one of each to fdroidserver, comments included', () => {
    // A grep cannot tell a comment from code: a second match anywhere in the
    // file decides our published version instead of the real one.
    const found = readFdroidVersions(gradle);
    expect(found.codes).toHaveLength(1);
    expect(found.names).toHaveLength(1);
  });

  it('computes nothing — the expression form F-Droid could not read is gone', () => {
    expect(gradle).not.toContain('nicotindVersion');
    expect(gradle).not.toContain('JsonSlurper');
    expect(gradle).not.toContain('NICOTIND_VERSION_CODE');
    expect(gradle).not.toContain('NICOTIND_VERSION_NAME');
  });
});

describe('build.gradle — reproducible build', () => {
  // F-Droid rebuilds this APK and compares it byte-for-byte to the published
  // one. Both of these are inputs to that comparison, and both fail silently:
  // the build still succeeds, the APK is just no longer reproducible.
  it('keeps AGP dependency metadata out of the APK', () => {
    expect(gradle).toMatch(/dependenciesInfo\s*\{[\s\S]*?includeInApk\s*=\s*false/);
    expect(gradle).toMatch(/dependenciesInfo\s*\{[\s\S]*?includeInBundle\s*=\s*false/);
  });

  it('leaves minification off, which R8 would make non-deterministic', () => {
    expect(gradle).toContain('minifyEnabled false');
  });
});
