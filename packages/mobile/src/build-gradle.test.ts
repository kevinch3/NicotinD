import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { androidVersion } from './version.js';

/**
 * The Android version is derived twice — once in TypeScript (`androidVersion`,
 * which CI feeds to gradle through the environment) and once in Groovy, inside
 * `build.gradle`, for every build that does NOT run our CI scripts: a
 * contributor's local `assembleRelease`, and F-Droid's buildserver, which
 * checks out the source and runs gradle directly.
 *
 * Two derivations of one number is a drift hazard nothing else catches. A
 * mismatch does not fail a build — it ships an APK that lies about its version,
 * and no store can update an app whose versionCode went backwards or stuck.
 * These tests pin the Groovy side to the TypeScript one.
 *
 * The behaviour itself was verified by evaluating the real gradle config with
 * no environment set: versionCode 8000 / versionName 0.8.0 at monorepo 0.8.0,
 * where the previous placeholder produced 1 / "1.0".
 */
const gradle = readFileSync(join(import.meta.dir, '..', 'android', 'app', 'build.gradle'), 'utf8');

describe('build.gradle — version derivation', () => {
  it('falls back to a real version, never a placeholder', () => {
    // The old `: 1` / `?: "1.0"` defaults are the specific failure: gradle
    // accepted them silently and produced an unupdatable APK.
    expect(gradle).not.toMatch(/versionCode\s+envVersionCode\s*\?[^:]*:\s*1\b/);
    expect(gradle).not.toMatch(/versionName\s+envVersionName\s*\?:\s*"1\.0"/);
    expect(gradle).toContain('nicotindVersion.code');
    expect(gradle).toContain('nicotindVersion.name');
  });

  it('reads the monorepo package.json rather than a copy of the version', () => {
    expect(gradle).toContain('package.json');
    expect(gradle).toContain('JsonSlurper');
  });

  it('keeps the environment as the override, so CI still wins', () => {
    expect(gradle).toContain('System.getenv("NICOTIND_VERSION_CODE")');
    expect(gradle).toContain('System.getenv("NICOTIND_VERSION_NAME")');
  });

  it('uses the same monotonic scheme as androidVersion()', () => {
    // Pull the two multipliers straight out of the Groovy and apply them here.
    // Underscores are Groovy's numeric separators, as in the TypeScript.
    const formula = /major\s*\*\s*([\d_]+)\s*\+\s*minor\s*\*\s*([\d_]+)\s*\+\s*patch/.exec(gradle);
    expect(formula).not.toBeNull();
    const majorMul = Number(formula![1].replaceAll('_', ''));
    const minorMul = Number(formula![2].replaceAll('_', ''));

    for (const [major, minor, patch] of [
      [0, 8, 0],
      [1, 0, 0],
      [0, 6, 55],
      [12, 999, 999],
    ]) {
      const semver = `${major}.${minor}.${patch}`;
      expect(major * majorMul + minor * minorMul + patch).toBe(androidVersion(semver).versionCode);
    }
  });

  it('rejects the minor/patch overflow androidVersion() rejects', () => {
    // Both sides must refuse >= 1000, or the versionCode stops being monotonic
    // and gradle would ship the broken number CI would have refused to compute.
    expect(gradle).toContain('minor >= 1000 || patch >= 1000');
    expect(() => androidVersion('1.1000.0')).toThrow();
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
