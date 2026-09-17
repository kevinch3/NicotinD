import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * First manifest-content test (issue #388): the Android TV launcher contract is
 * pure XML that no compiler checks — a lost `LEANBACK_LAUNCHER` category or
 * banner reference would ship silently and only surface as "the app vanished
 * from the TV home screen".
 */
const ANDROID_APP = join(import.meta.dir, '..', 'android', 'app', 'src', 'main');
const manifest = readFileSync(join(ANDROID_APP, 'AndroidManifest.xml'), 'utf8');

describe('AndroidManifest.xml — Android TV launcher contract', () => {
  it('declares LEANBACK_LAUNCHER in the same MAIN intent-filter as LAUNCHER', () => {
    const filters = manifest.match(/<intent-filter>[\s\S]*?<\/intent-filter>/g) ?? [];
    const mainFilter = filters.find((f) => f.includes('android.intent.action.MAIN'));
    expect(mainFilter).toBeDefined();
    expect(mainFilter).toContain('android.intent.category.LEANBACK_LAUNCHER');
    // Phone regression guard: the phone launcher category must survive.
    expect(mainFilter).toContain('android.intent.category.LAUNCHER');
  });

  it('declares the leanback software feature as optional (phones stay installable)', () => {
    expect(manifest).toMatch(
      /<uses-feature\s+android:name="android\.software\.leanback"\s+android:required="false"\s*\/>/,
    );
  });

  it('keeps the touchscreen feature optional (TV boxes have none)', () => {
    expect(manifest).toMatch(
      /<uses-feature\s+android:name="android\.hardware\.touchscreen"\s+android:required="false"\s*\/>/,
    );
  });

  it('declares the Assistant MEDIA_PLAY_FROM_SEARCH filter separately from the MAIN filter', () => {
    const filters = manifest.match(/<intent-filter>[\s\S]*?<\/intent-filter>/g) ?? [];
    const searchFilter = filters.find((f) =>
      f.includes('android.media.action.MEDIA_PLAY_FROM_SEARCH'),
    );
    expect(searchFilter).toBeDefined();
    // Never merged into the MAIN filter — extra actions/categories there
    // would change launcher matching.
    expect(searchFilter).not.toContain('android.intent.action.MAIN');
  });

  it('allows cleartext http — self-hosted LAN servers have no TLS (#390)', () => {
    expect(manifest).toMatch(/<application[\s\S]*?android:usesCleartextTraffic="true"[\s\S]*?>/);
  });

  it('asks for no camera at all — the QR scanner was removed (#1168)', () => {
    // Stated as the new truth rather than deleted: the CAMERA permission and the
    // camera uses-feature both existed only for `@capacitor/barcode-scanner`,
    // whose Android implementation came from a private Maven feed. Dropping the
    // plugin dropped the reason, and an app that asks for a camera it cannot use
    // is a permission prompt with nothing behind it.
    expect(manifest).not.toContain('android.permission.CAMERA');
    expect(manifest).not.toContain('android.hardware.camera');
  });

  it('points the application at the TV banner drawable', () => {
    expect(manifest).toMatch(/<application[\s\S]*?android:banner="@drawable\/banner"[\s\S]*?>/);
  });

  it('declares REQUEST_INSTALL_PACKAGES — the sideloaded APK self-updates from GitHub releases', () => {
    expect(manifest).toContain(
      '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
    );
  });

  it('keeps the FileProvider cache path the APK self-update installer depends on', () => {
    // The apk-update plugin serves the downloaded APK to the system installer
    // through the app FileProvider; a dropped <cache-path> would break it at
    // runtime with no compile signal.
    const filePaths = readFileSync(join(ANDROID_APP, 'res', 'xml', 'file_paths.xml'), 'utf8');
    expect(filePaths).toMatch(/<cache-path[^>]*path="\."[^>]*\/>/);
  });
});

/**
 * The F-Droid flavor overlay (issue #1168). Verified end to end against the
 * merged manifest during development; these tests hold the contract that makes
 * that merge correct, since no compiler reads either XML file.
 */
describe('AndroidManifest.xml — F-Droid flavor overlay', () => {
  const overlay = readFileSync(
    join(import.meta.dir, '..', 'android', 'app', 'src', 'fdroid', 'AndroidManifest.xml'),
    'utf8',
  );

  it('declares the tools namespace that tools:node="remove" needs', () => {
    // Without it the merger treats tools:node as an unknown attribute and the
    // permissions survive — the failure is a silently over-permissioned APK.
    expect(overlay).toContain('xmlns:tools="http://schemas.android.com/tools"');
  });

  it('removes REQUEST_INSTALL_PACKAGES — F-Droid is the updater there', () => {
    expect(overlay).toMatch(
      /<uses-permission[\s\S]*?android\.permission\.REQUEST_INSTALL_PACKAGES[\s\S]*?tools:node="remove"[\s\S]*?\/>/,
    );
  });

  it('no longer removes the camera — the main manifest stopped declaring it', () => {
    // The overlay used to strip CAMERA because the F-Droid build dropped the
    // scanner. Since #1168 removed the scanner from EVERY build, main declares
    // no camera and a removal here would match nothing — dead config, which the
    // "removes nothing the main manifest does not declare" test below catches.
    expect(overlay).not.toContain('android.permission.CAMERA');
    expect(overlay).not.toContain('android.hardware.camera');
  });

  it('only ever removes — the launcher contract stays in one manifest', () => {
    // An <activity>/<intent-filter> here would fork the TV launcher contract the
    // tests above guard, and the fork would only show up on F-Droid installs.
    const nodes =
      overlay.match(/<(uses-permission|uses-feature|activity|provider|application)\b/g) ?? [];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(['<uses-permission', '<uses-feature']).toContain(node);
    }
    const removals = overlay.match(/tools:node="remove"/g) ?? [];
    expect(removals.length).toBe(nodes.length);
  });

  it('removes nothing the main manifest does not declare', () => {
    // A removal that matches nothing is dead config: it reads as protection
    // while the real permission sits somewhere else under a different spelling.
    const targets = [...overlay.matchAll(/android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const name of targets) {
      expect(manifest).toContain(`android:name="${name}"`);
    }
  });

  it('is wired up as a gradle product flavor', () => {
    const gradle = readFileSync(
      join(import.meta.dir, '..', 'android', 'app', 'build.gradle'),
      'utf8',
    );
    // The overlay dir is inert unless a flavor of the same name exists.
    expect(gradle).toMatch(/flavorDimensions\s+"distribution"/);
    expect(gradle).toMatch(/fdroid\s*\{\s*dimension\s+"distribution"\s*\}/);
    expect(gradle).toMatch(/standard\s*\{\s*dimension\s+"distribution"\s*\}/);
  });

  it('takes the application id suffix from the environment', () => {
    const gradle = readFileSync(
      join(import.meta.dir, '..', 'android', 'app', 'build.gradle'),
      'utf8',
    );
    expect(gradle).toContain('System.getenv("NICOTIND_APP_ID_SUFFIX")');
  });
});

describe('TV banner asset', () => {
  const bannerPath = join(ANDROID_APP, 'res', 'drawable-xhdpi', 'banner.png');

  it('exists where the manifest points (committed, generated by icons:source)', () => {
    expect(existsSync(bannerPath)).toBe(true);
  });

  it('is a real PNG (magic bytes)', () => {
    const header = readFileSync(bannerPath).subarray(0, 8);
    expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
