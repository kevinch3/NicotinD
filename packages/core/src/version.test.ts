import { describe, expect, it } from 'bun:test';
import { compareVersions } from './version.js';

describe('compareVersions', () => {
  it('orders numeric dot versions', () => {
    expect(compareVersions('0.1.231', '0.1.230')).toBeGreaterThan(0);
    expect(compareVersions('0.1.230', '0.1.230')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.999')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.231', '0.1.230')).toBeGreaterThan(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
  });
});
