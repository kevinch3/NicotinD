import { describe, expect, it } from 'bun:test';
import { applyAndroidVersion, readFdroidVersions } from './android-version.js';

const gradle = (code: string | number, name: string, extra = ''): string =>
  [
    'android {',
    '    defaultConfig {',
    `        versionCode ${code}`,
    `        versionName "${name}"`,
    extra,
    '    }',
    '}',
    '',
  ].join('\n');

describe("readFdroidVersions — fdroidserver's own regexes", () => {
  it('reads the literals a released build.gradle carries', () => {
    expect(readFdroidVersions(gradle(8005, '0.8.5'))).toEqual({
      codes: ['8005'],
      names: ['0.8.5'],
    });
  });

  it('reads NOTHING from a computed versionCode — the bug this replaced', () => {
    // What the file used to say. F-Droid's checkupdates saw no version at all.
    const computed = '        versionCode envVersionCode ? envVersionCode.toInteger() : v.code\n';
    expect(readFdroidVersions(computed).codes).toEqual([]);
  });

  it('sees a match inside a comment, because a grep cannot tell the difference', () => {
    expect(readFdroidVersions('// e.g. versionCode 1\nversionCode 8005\n').codes).toEqual([
      '1',
      '8005',
    ]);
  });
});

describe('applyAndroidVersion', () => {
  it('writes both literals from the monorepo semver', () => {
    const out = applyAndroidVersion(gradle(1, '0.0.1'), '0.8.5');
    expect(readFdroidVersions(out)).toEqual({ codes: ['8005'], names: ['0.8.5'] });
  });

  it('uses the shared monotonic scheme, not a second copy of it', () => {
    // major*1e6 + minor*1e3 + patch, via androidVersion().
    expect(readFdroidVersions(applyAndroidVersion(gradle(1, 'x'), '1.2.3')).codes).toEqual([
      '1002003',
    ]);
  });

  it('is idempotent — the release hook can run twice', () => {
    const once = applyAndroidVersion(gradle(1, '0.0.1'), '0.8.5');
    expect(applyAndroidVersion(once, '0.8.5')).toBe(once);
  });

  it('changes nothing else in the file', () => {
    const src = gradle(1, '0.0.1', '        applicationId "ar.kevinroberts.nicotind"');
    expect(applyAndroidVersion(src, '0.8.5')).toContain(
      '        applicationId "ar.kevinroberts.nicotind"',
    );
  });

  it('drops a pre-release suffix, as androidVersion() does', () => {
    expect(readFdroidVersions(applyAndroidVersion(gradle(1, 'x'), '0.9.0-rc.1')).names).toEqual([
      '0.9.0',
    ]);
  });

  // The failure that matters: a second match means F-Droid reads whichever its
  // regex hits first, and nothing in our CI would notice.
  it('refuses when a second versionCode appears anywhere, comments included', () => {
    const withComment = '// like versionCode 1\n' + gradle(8005, '0.8.5');
    expect(() => applyAndroidVersion(withComment, '0.8.5')).toThrow(/found 2/);
  });

  it('refuses when the field is missing rather than writing nothing', () => {
    expect(() => applyAndroidVersion('android {\n}\n', '0.8.5')).toThrow(/found 0/);
  });
});
