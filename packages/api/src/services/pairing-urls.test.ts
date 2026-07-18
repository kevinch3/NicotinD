import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { candidateUrls, isLoopbackOrigin } from './pairing-urls.js';
import {
  parseTailscaleStatus,
  parseFunnelEnableUrl,
  parseOperatorDenied,
  RemoteAccess,
  type ExecResult,
} from './tailscale.js';
import { applySchema } from '../db.js';

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

// The real stderr from tailscaled's Linux operator restriction (funnel/serve
// config is root-only until `tailscale set --operator=<user>` is run once).
const OPERATOR_DENIED_STDERR =
  "sending serve config: Access denied: serve config denied Use 'sudo tailscale funnel --bg 43023'. " +
  "To not require root, use 'sudo tailscale set --operator=$USER' once.";

describe('parseOperatorDenied', () => {
  it('detects the operator-denied stderr', () => {
    expect(parseOperatorDenied(OPERATOR_DENIED_STDERR)).toBeTrue();
  });

  it('ignores unrelated failures', () => {
    expect(parseOperatorDenied('Funnel not available; node attribute not set')).toBeFalse();
    expect(parseOperatorDenied('access denied: something else entirely')).toBeFalse();
  });
});

describe('RemoteAccess — needs-operator state', () => {
  it('surfaces the guided one-time command when funnel arming is operator-denied', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('remote_access', '{"enabled":true}')`,
    );

    const runner = async (args: string[]): Promise<ExecResult> => {
      if (args[0] === 'funnel') {
        return { stdout: '', stderr: OPERATOR_DENIED_STDERR, code: 1 };
      }
      // status --json: installed + logged in
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'desk.tail1234.ts.net.' },
        }),
        stderr: '',
        code: 0,
      };
    };

    const remote = new RemoteAccess(db, runner);
    await remote.onServerStarted(43023);
    const { state } = await remote.status();

    expect(state.kind).toBe('needs-operator');
    expect((state as { command: string }).command).toMatch(
      /^sudo tailscale set --operator=\S+$/,
    );
  });
});
