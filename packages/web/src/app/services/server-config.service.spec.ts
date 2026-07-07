import { ServerConfigService } from './server-config.service';

describe('ServerConfigService', () => {
  let svc: ServerConfigService;

  beforeEach(() => {
    localStorage.clear();
    svc = new ServerConfigService();
  });

  it('builds a same-origin stream URL with the token and an ngsw-bypass flag', () => {
    const url = svc.streamUrl('abc123', 'tok');
    expect(url).toBe('/api/stream/abc123?token=tok&ngsw-bypass=1');
  });

  it('always appends ngsw-bypass so the Angular service worker never intercepts audio streams', () => {
    // Regression: Driver.handleFetch() in ngsw-worker.js intercepts every
    // same-origin fetch unconditionally — there's no dataGroup configured to
    // opt /api/stream out — and in Firefox that interception occasionally
    // throws for a Range request instead of falling through to the network,
    // which surfaced as a track that never plays. ngsw-bypass is Angular's own
    // documented escape hatch (onFetch() returns immediately when it's present).
    const url = svc.streamUrl('track-id', 'jwt');
    expect(url).toContain('ngsw-bypass=1');
  });
});
