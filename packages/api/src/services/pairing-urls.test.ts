import { describe, expect, it } from 'bun:test';
import { candidateUrls, isLoopbackOrigin } from './pairing-urls.js';
import { parseTailscaleStatus, parseFunnelEnableUrl } from './tailscale.js';

describe('candidateUrls', () => {
  it('puts the funnel URL first, then the request origin', () => {
    expect(
      candidateUrls({
        funnelUrl: 'https://desk.tail1234.ts.net',
        requestOrigin: 'https://music.example.com',
      }),
    ).toEqual(['https://desk.tail1234.ts.net', 'https://music.example.com']);
  });

  it('drops loopback request origins', () => {
    expect(candidateUrls({ funnelUrl: null, requestOrigin: 'http://127.0.0.1:8484' })).toEqual([]);
    expect(candidateUrls({ funnelUrl: null, requestOrigin: 'http://localhost:8484' })).toEqual([]);
    expect(candidateUrls({ funnelUrl: null, requestOrigin: 'http://[::1]:8484' })).toEqual([]);
  });

  it('dedupes identical candidates', () => {
    expect(
      candidateUrls({
        funnelUrl: 'https://desk.tail1234.ts.net',
        requestOrigin: 'https://desk.tail1234.ts.net',
      }),
    ).toEqual(['https://desk.tail1234.ts.net']);
  });
});

describe('isLoopbackOrigin', () => {
  it('treats unparseable origins as loopback (unusable)', () => {
    expect(isLoopbackOrigin('not a url')).toBeTrue();
  });

  it('keeps real hosts', () => {
    expect(isLoopbackOrigin('http://192.168.1.20:8484')).toBeFalse();
    expect(isLoopbackOrigin('https://music.example.com')).toBeFalse();
  });
});

describe('parseTailscaleStatus', () => {
  it('reads logged-in state and strips the DNS trailing dot', () => {
    const status = parseTailscaleStatus(
      JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'desk.tail1234.ts.net.' },
      }),
    );
    expect(status).toEqual({
      loggedIn: true,
      magicDnsName: 'desk.tail1234.ts.net',
      authUrl: null,
    });
  });

  it('surfaces NeedsLogin with an auth URL', () => {
    const status = parseTailscaleStatus(
      JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc' }),
    );
    expect(status?.loggedIn).toBeFalse();
    expect(status?.authUrl).toBe('https://login.tailscale.com/a/abc');
  });

  it('returns null for garbage output', () => {
    expect(parseTailscaleStatus('not json')).toBeNull();
  });
});

describe('parseFunnelEnableUrl', () => {
  it('extracts the admin-console enable URL from CLI stderr', () => {
    const stderr =
      'Funnel not available; "funnel" node attribute not set.\n' +
      'To enable, visit:\n\n\thttps://login.tailscale.com/f/funnel?node=n123.\n';
    expect(parseFunnelEnableUrl(stderr)).toBe('https://login.tailscale.com/f/funnel?node=n123');
  });

  it('returns null when no enable URL is present', () => {
    expect(parseFunnelEnableUrl('some other failure')).toBeNull();
  });
});
