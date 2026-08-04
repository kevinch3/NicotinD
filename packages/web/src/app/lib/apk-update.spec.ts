import { apkAssetUrl, apkFileName, parseLatestRelease } from './apk-update';

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
