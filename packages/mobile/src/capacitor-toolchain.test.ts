import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The native projects are hand-maintained, but their toolchain is dictated by
 * the installed Capacitor. A `@capacitor/*` bump that leaves them behind still
 * installs and typechecks — the Android project fails only in the tag-only
 * release job, and the iOS pod target only on a Mac. These pin both to the
 * values Capacitor itself builds with. See docs/mobile-app.md "Capacitor version".
 */
const require = createRequire(import.meta.url);
const mobile = join(import.meta.dir, '..');
const packages = join(mobile, '..');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

const capGradle = read(pkgDir('@capacitor/android'), 'capacitor', 'build.gradle');
const agp = (s: string) => /com\.android\.tools\.build:gradle:([\d.]+)/.exec(s)?.[1];
const fallback = (s: string, key: string) =>
  new RegExp(`project\\.hasProperty\\('${key}'\\)\\s*\\?[^:]+:\\s*(\\d+)`).exec(s)?.[1];
const javaVersion = (s: string) => /sourceCompatibility\s+JavaVersion\.VERSION_(\d+)/.exec(s)?.[1];

const ownPlugins = ['capacitor-apk-update', 'capacitor-tv-channels'].map((name) => ({
  name,
  gradle: read(packages, name, 'android', 'build.gradle'),
}));

describe('Android project follows the installed Capacitor', () => {
  const variables = read(mobile, 'android', 'variables.gradle');
  const variable = (key: string) =>
    Number(new RegExp(`${key}\\s*=\\s*(\\d+)`).exec(variables)?.[1]);

  it('uses the Android Gradle Plugin Capacitor builds with', () => {
    expect(agp(capGradle)).toBeDefined();
    expect(agp(read(mobile, 'android', 'build.gradle'))).toBe(agp(capGradle));
    for (const p of ownPlugins) expect([p.name, agp(p.gradle)]).toEqual([p.name, agp(capGradle)]);
  });

  it('compiles and targets the SDK level Capacitor defaults to', () => {
    for (const key of ['compileSdkVersion', 'targetSdkVersion']) {
      expect([key, variable(key)]).toEqual([key, Number(fallback(capGradle, key))]);
    }
    expect(variable('minSdkVersion')).toBeGreaterThanOrEqual(
      Number(fallback(capGradle, 'minSdkVersion')),
    );
  });

  it("keeps our plugins' standalone fallbacks and Java level on Capacitor's", () => {
    for (const p of ownPlugins) {
      for (const key of ['compileSdkVersion', 'targetSdkVersion']) {
        expect([p.name, key, fallback(p.gradle, key)]).toEqual([
          p.name,
          key,
          fallback(capGradle, key),
        ]);
      }
      expect([p.name, javaVersion(p.gradle)]).toEqual([p.name, javaVersion(capGradle)]);
    }
  });
});

describe('iOS plugin pod follows the installed Capacitor', () => {
  const target = (s: string) => /s\.ios\.deployment_target\s*=\s*'([\d.]+)'/.exec(s)?.[1];

  it("declares Capacitor's own deployment target", () => {
    const cap = target(read(pkgDir('@capacitor/ios'), 'Capacitor.podspec'));
    expect(cap).toBeDefined();
    expect(
      target(read(packages, 'capacitor-now-playing', 'NicotindCapacitorNowPlaying.podspec')),
    ).toBe(cap);
  });
});

describe('SystemBars viewport hint', () => {
  it('matches the viewport-fit index.html actually declares', () => {
    const config = read(mobile, 'capacitor.config.ts');
    const hint = /initialViewportFitValueHint:\s*'(\w+)'/.exec(config)?.[1];
    const html = read(packages, 'web', 'src', 'index.html');
    const fit = /<meta name="viewport"[^>]*viewport-fit=(\w+)/.exec(html)?.[1];
    expect(hint).toBe(fit);
  });
});
