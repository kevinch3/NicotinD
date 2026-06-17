import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  buildApiUrl,
  buildWsUrl,
  isHealthyResponse,
} from './server-url';

describe('normalizeServerUrl', () => {
  it('returns empty for blank input (web same-origin sentinel)', () => {
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl('   ')).toBe('');
    expect(normalizeServerUrl(null)).toBe('');
    expect(normalizeServerUrl(undefined)).toBe('');
  });

  it('defaults to https when no scheme is given', () => {
    expect(normalizeServerUrl('nicotined.kevinroberts.ar')).toBe(
      'https://nicotined.kevinroberts.ar',
    );
  });

  it('preserves an explicit http scheme (LAN servers)', () => {
    expect(normalizeServerUrl('http://192.168.1.10:8484')).toBe('http://192.168.1.10:8484');
  });

  it('strips path, query and trailing slash down to the origin', () => {
    expect(normalizeServerUrl('https://host.tld/some/path/?q=1')).toBe('https://host.tld');
    expect(normalizeServerUrl('https://host.tld/')).toBe('https://host.tld');
  });

  it('returns empty for unparseable input', () => {
    expect(normalizeServerUrl('http://')).toBe('');
  });

  it('the default constant is a clean origin', () => {
    expect(normalizeServerUrl(DEFAULT_SERVER_URL)).toBe(DEFAULT_SERVER_URL);
  });
});

describe('buildApiUrl', () => {
  it('is a no-op for relative paths when base is empty (web)', () => {
    expect(buildApiUrl('', '/api/library/albums')).toBe('/api/library/albums');
    expect(buildApiUrl('', '/rest/ping')).toBe('/rest/ping');
  });

  it('prefixes the base for /api and /rest paths (native)', () => {
    expect(buildApiUrl('https://srv.tld', '/api/stream/1?token=x')).toBe(
      'https://srv.tld/api/stream/1?token=x',
    );
    expect(buildApiUrl('https://srv.tld', '/rest/ping')).toBe('https://srv.tld/rest/ping');
  });

  it('leaves non-api relative paths untouched even with a base', () => {
    expect(buildApiUrl('https://srv.tld', '/assets/logo.png')).toBe('/assets/logo.png');
  });

  it('passes absolute URLs through unchanged', () => {
    expect(buildApiUrl('https://srv.tld', 'https://other.tld/api/x')).toBe(
      'https://other.tld/api/x',
    );
    expect(buildApiUrl('', 'https://other.tld/api/x')).toBe('https://other.tld/api/x');
  });
});

describe('buildWsUrl', () => {
  const fallback = { protocol: 'https:', host: 'page.tld' };

  it('uses the page origin when base is empty (web)', () => {
    expect(buildWsUrl('', '/api/ws/playback?token=x', fallback)).toBe(
      'wss://page.tld/api/ws/playback?token=x',
    );
    expect(buildWsUrl('', '/api/ws/playback', { protocol: 'http:', host: 'localhost:4200' })).toBe(
      'ws://localhost:4200/api/ws/playback',
    );
  });

  it('maps the configured base scheme to ws/wss (native)', () => {
    expect(buildWsUrl('https://srv.tld', '/api/ws/playback?token=x', fallback)).toBe(
      'wss://srv.tld/api/ws/playback?token=x',
    );
    expect(buildWsUrl('http://192.168.1.10:8484', '/api/ws/playback', fallback)).toBe(
      'ws://192.168.1.10:8484/api/ws/playback',
    );
  });
});

describe('isHealthyResponse', () => {
  it('accepts the server health body', () => {
    expect(isHealthyResponse({ ok: true })).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isHealthyResponse({ ok: false })).toBe(false);
    expect(isHealthyResponse({})).toBe(false);
    expect(isHealthyResponse(null)).toBe(false);
    expect(isHealthyResponse('ok')).toBe(false);
    expect(isHealthyResponse(undefined)).toBe(false);
  });
});
