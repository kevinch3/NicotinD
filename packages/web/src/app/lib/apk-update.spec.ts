import { apkAssetUrl, apkFileName, isSideloadInstaller, parseLatestRelease } from './apk-update';

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

describe('isSideloadInstaller', () => {
  it("recognises Android's own package installer, OEM variants included", () => {
    // A downloaded APK and our ACTION_VIEW self-update both report it.
    for (const installer of [
      'com.google.android.packageinstaller',
      'com.android.packageinstaller',
      'com.miui.packageinstaller',
    ]) {
      expect(isSideloadInstaller(installer), installer).toBe(true);
    }
  });

  // #1503: the blocklist this replaced missed F-Droid clients installing via
  // root/Shizuku, which report the shell or no installer at all.
  it('treats every store, tool and unknown installer as not a sideload', () => {
    for (const installer of [
      'org.fdroid.fdroid',
      'org.fdroid.basic',
      'com.looker.droidify',
      'com.machiav3lli.fdroid',
      'com.android.vending',
      'com.android.shell',
      'org.fdroid.fdroid.privileged',
      '',
    ]) {
      expect(isSideloadInstaller(installer), installer).toBe(false);
    }
    expect(isSideloadInstaller(null)).toBe(false);
    expect(isSideloadInstaller(undefined)).toBe(false);
  });

  it('matches the whole name, not a substring', () => {
    expect(isSideloadInstaller('packageinstaller')).toBe(false);
    expect(isSideloadInstaller('com.android.packageinstaller.evil')).toBe(false);
  });
});
