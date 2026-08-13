import { describe, expect, it } from 'bun:test';
import { assertFetchableUrl, isPrivateIpHost, SsrfBlockedError } from './fetch-guard.js';

describe('isPrivateIpHost', () => {
  it('flags IPv4 loopback / private / link-local / unspecified ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1', // link-local
      '0.0.0.0',
      '100.64.0.1', // CGNAT
    ]) {
      expect(isPrivateIpHost(ip)).toBe(true);
    }
  });

  it('does NOT flag public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isPrivateIpHost(ip)).toBe(false);
    }
  });

  it('flags IPv6 loopback / ULA / link-local / mapped-private', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::']) {
      expect(isPrivateIpHost(ip)).toBe(true);
    }
  });

  it('does NOT flag public IPv6 or non-IP hostnames', () => {
    expect(isPrivateIpHost('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIpHost('example.com')).toBe(false); // not an IP literal
  });
});

describe('assertFetchableUrl', () => {
  it('returns the parsed URL for a public https target', () => {
    const url = assertFetchableUrl('https://example.com/cover.jpg');
    expect(url.hostname).toBe('example.com');
  });

  it('allows http as well as https', () => {
    expect(() => assertFetchableUrl('http://example.com/x')).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    for (const raw of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi']) {
      expect(() => assertFetchableUrl(raw)).toThrow(SsrfBlockedError);
    }
  });

  it('rejects a malformed URL', () => {
    expect(() => assertFetchableUrl('not a url')).toThrow(SsrfBlockedError);
  });

  it('rejects literal private / loopback hosts', () => {
    for (const raw of [
      'http://127.0.0.1:8484/api/admin',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata SSRF
      'http://[::1]:8484/',
      'http://[fd00::1]/',
    ]) {
      expect(() => assertFetchableUrl(raw)).toThrow(SsrfBlockedError);
    }
  });

  it('rejects localhost by name', () => {
    expect(() => assertFetchableUrl('http://localhost:8484/')).toThrow(SsrfBlockedError);
    expect(() => assertFetchableUrl('http://sub.localhost/')).toThrow(SsrfBlockedError);
  });

  it('enforces an allowlist when given — off-list public host is rejected', () => {
    const allowedHosts = new Set(['images.lidarr.audio']);
    expect(() =>
      assertFetchableUrl('https://images.lidarr.audio/x.jpg', { allowedHosts }),
    ).not.toThrow();
    expect(() => assertFetchableUrl('https://evil.example.com/x', { allowedHosts })).toThrow(
      SsrfBlockedError,
    );
  });

  it('an allowlist match is exact host, not a suffix (no prefix-bypass)', () => {
    const allowedHosts = new Set(['images.lidarr.audio']);
    expect(() =>
      assertFetchableUrl('https://images.lidarr.audio.evil.com/x', { allowedHosts }),
    ).toThrow(SsrfBlockedError);
  });
});
