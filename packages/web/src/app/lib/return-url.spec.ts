import { describe, it, expect } from 'vitest';
import { sanitizeReturnUrl } from './return-url';

describe('sanitizeReturnUrl', () => {
  it('keeps a rooted in-app path (incl. query + fragment)', () => {
    expect(sanitizeReturnUrl('/library/artists/abc')).toBe('/library/artists/abc');
    expect(sanitizeReturnUrl('/library?type=artists')).toBe('/library?type=artists');
    expect(sanitizeReturnUrl('/library/albums/x#top')).toBe('/library/albums/x#top');
  });

  it('falls back to / for empty/nullish input', () => {
    expect(sanitizeReturnUrl(null)).toBe('/');
    expect(sanitizeReturnUrl(undefined)).toBe('/');
    expect(sanitizeReturnUrl('')).toBe('/');
    expect(sanitizeReturnUrl('   ')).toBe('/');
  });

  it('rejects absolute / scheme URLs (open-redirect guard)', () => {
    expect(sanitizeReturnUrl('https://evil.com')).toBe('/');
    expect(sanitizeReturnUrl('http://evil.com/x')).toBe('/');
    expect(sanitizeReturnUrl('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnUrl('nicotind://x')).toBe('/');
  });

  it('rejects protocol-relative and backslash-smuggled authorities', () => {
    expect(sanitizeReturnUrl('//evil.com')).toBe('/');
    expect(sanitizeReturnUrl('/\\evil.com')).toBe('/');
  });

  it('rejects a non-rooted path', () => {
    expect(sanitizeReturnUrl('library/artists/x')).toBe('/');
  });

  it('does not loop back into /login', () => {
    expect(sanitizeReturnUrl('/login')).toBe('/');
    expect(sanitizeReturnUrl('/login?returnUrl=/x')).toBe('/');
  });
});
