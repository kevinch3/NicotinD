import { describe, expect, it } from 'bun:test';
import { androidVersion } from './version.js';

describe('androidVersion', () => {
  it('maps a semver to versionName + a monotonic versionCode', () => {
    expect(androidVersion('0.1.83')).toEqual({ versionName: '0.1.83', versionCode: 1083 });
    expect(androidVersion('1.0.0')).toEqual({ versionName: '1.0.0', versionCode: 1_000_000 });
    expect(androidVersion('2.5.9')).toEqual({ versionName: '2.5.9', versionCode: 2_005_009 });
  });

  it('keeps versionCode strictly increasing across patch/minor/major bumps', () => {
    const code = (v: string) => androidVersion(v).versionCode;
    expect(code('0.1.82')).toBeLessThan(code('0.1.83'));
    expect(code('0.1.999')).toBeLessThan(code('0.2.0'));
    expect(code('0.999.999')).toBeLessThan(code('1.0.0'));
  });

  it('tolerates surrounding whitespace and trailing pre-release/build suffixes', () => {
    expect(androidVersion('  0.1.83  ').versionCode).toBe(1083);
    expect(androidVersion('1.2.3-rc.1').versionName).toBe('1.2.3');
  });

  it('throws on unparseable input', () => {
    expect(() => androidVersion('not-a-version')).toThrow();
    expect(() => androidVersion('1.2')).toThrow();
  });

  it('rejects minor/patch ≥ 1000 (would break monotonicity)', () => {
    expect(() => androidVersion('1.1000.0')).toThrow();
    expect(() => androidVersion('1.0.1000')).toThrow();
  });
});
