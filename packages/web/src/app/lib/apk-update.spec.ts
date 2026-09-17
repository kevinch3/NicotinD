import {
  apkAssetUrl,
  apkFileName,
  isStoreManagedInstaller,
  parseLatestRelease,
} from './apk-update';

describe('apk-update helpers (sideloaded APK self-update from GitHub releases)', () => {
  it('parses the latest-release version, stripping the v prefix', () => {
    expect(parseLatestRelease({ tag_name: 'v0.1.305' })).toBe('0.1.305');
    expect(parseLatestRelease({ tag_name: '0.1.305' })).toBe('0.1.305');
  });

  it('returns null on a malformed release body', () => {
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('nope')).toBeNull();
    expect(parseLatestRelease({ tag_name: 42 })).toBeNull();
  });

  it('builds the release asset URL for the phone and TV APK flavors', () => {
    // Asset names must match what deploy.yml attaches to the release.
    expect(apkAssetUrl('0.1.305', false)).toBe(
      'https://github.com/kevinch3/NicotinD/releases/download/v0.1.305/NicotinD-0.1.305.apk',
    );
    expect(apkAssetUrl('0.1.305', true)).toBe(
      'https://github.com/kevinch3/NicotinD/releases/download/v0.1.305/NicotinD-TV-0.1.305.apk',
    );
  });

  it('derives the local download file name from the same flavor', () => {
    expect(apkFileName('0.1.305', false)).toBe('NicotinD-0.1.305.apk');
    expect(apkFileName('0.1.305', true)).toBe('NicotinD-TV-0.1.305.apk');
  });
});

describe('isStoreManagedInstaller', () => {
  it('recognises F-Droid and the clients people actually use', () => {
    // One APK serves both channels since #1168, so this decides at runtime what
    // used to be a build flavor. Forks matter: most F-Droid users are not on the
    // official client.
    for (const installer of [
      'org.fdroid.fdroid',
      'org.fdroid.basic',
      'com.looker.droidify',
      'com.machiav3lli.fdroid',
    ]) {
      expect(isStoreManagedInstaller(installer), installer).toBe(true);
    }
  });

  it('treats an unknown or absent installer as a sideload', () => {
    // Failing this way leaves the in-app updater available. The opposite error
    // strands a sideloading user on an old build with no way to move.
    expect(isStoreManagedInstaller(null)).toBe(false);
    expect(isStoreManagedInstaller(undefined)).toBe(false);
    expect(isStoreManagedInstaller('')).toBe(false);
    expect(isStoreManagedInstaller('com.android.packageinstaller')).toBe(false);
    expect(isStoreManagedInstaller('org.fdroid.fdroid.privileged')).toBe(false);
  });

  it('does not match on a substring', () => {
    // 'com.evil.org.fdroid.fdroid' is not F-Droid.
    expect(isStoreManagedInstaller('com.evil.org.fdroid.fdroid')).toBe(false);
    expect(isStoreManagedInstaller('org.fdroid')).toBe(false);
  });
});
