import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FDROID_APPS, fdroidAppMetadata, fdroidRepoConfig } from './fdroid-repo.js';
import { fdroidAppId } from './fdroid.js';

describe('FDROID_APPS', () => {
  it('gives every entry a distinct application id and a distinct name', () => {
    // F-Droid requires distinct ids, and two rows both called "NicotinD" would
    // be unpickable in the client.
    const ids = FDROID_APPS.map((a) => a.applicationId);
    const names = FDROID_APPS.map((a) => a.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('agrees with fdroidAppId about the suffix the TV build is assembled with', () => {
    // Two places encode ".tv": the gradle suffix and this list. If they drift,
    // the repo advertises an id no APK carries and the entry installs nothing.
    const base = 'ar.kevinroberts.nicotind';
    expect(ids()).toContain(fdroidAppId(base, false));
    expect(ids()).toContain(fdroidAppId(base, true));
    function ids() {
      return FDROID_APPS.map((a) => a.applicationId);
    }
  });

  it('points every entry at a fastlane tree that exists', () => {
    for (const app of FDROID_APPS) {
      const dir = join(import.meta.dir, '..', app.fastlaneDir, 'metadata', 'android');
      expect(existsSync(dir), `${app.fastlaneDir} is missing`).toBe(true);
    }
  });

  it('gives every entry a distinct APK name', () => {
    // Both land in one repo/ directory; a shared name would silently publish
    // one APK twice and drop the other.
    const apks = FDROID_APPS.map((a) => a.apk);
    expect(new Set(apks).size).toBe(apks.length);
  });
});

describe('fdroidRepoConfig', () => {
  const config = fdroidRepoConfig({
    repoUrl: 'https://example.test/NicotinD/fdroid/repo',
    keystore: 'repo.keystore',
    keystorePassword: 'pw',
    keyAlias: 'alias',
  });

  it('carries the repo url, keystore and alias fdroid update needs', () => {
    expect(config).toContain('repo_url: https://example.test/NicotinD/fdroid/repo');
    expect(config).toContain('keystore: repo.keystore');
    expect(config).toContain('repo_keyalias: alias');
  });

  it('quotes the password so a shell-special character cannot break the yaml', () => {
    const withSpecials = fdroidRepoConfig({
      repoUrl: 'https://example.test/repo',
      keystore: 'k',
      keystorePassword: 'a#b: c',
      keyAlias: 'a',
    });
    expect(withSpecials).toContain('keystorepass: "a#b: c"');
  });

  it('keeps every version in the main index rather than an archive we do not publish', () => {
    expect(config).toContain('archive_older: 0');
  });
});

describe('fdroidAppMetadata', () => {
  const tv = FDROID_APPS.find((a) => a.applicationId.endsWith('.tv'))!;
  const meta = fdroidAppMetadata(tv, 6056);

  it('sets the distinct Name, which is what --create-metadata would get wrong', () => {
    // Left to itself, fdroidserver takes Name from the APK label — "NicotinD"
    // for both entries — and that outranks the fastlane title.txt.
    expect(meta).toContain('Name: NicotinD TV');
  });

  it('declares the licence and source so the listing is not bare', () => {
    expect(meta).toContain('License: AGPL-3.0-only');
    expect(meta).toContain('SourceCode: https://github.com/kevinch3/NicotinD');
  });

  it('sets CurrentVersionCode, which is what a changelog file name is matched against', () => {
    expect(meta).toContain('CurrentVersionCode: 6056');
  });

  it('does not hardcode a category fdroidserver would reject as unknown', () => {
    expect(meta).toContain('- Multimedia');
  });
});
