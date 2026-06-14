import { describe, expect, it } from 'bun:test';
import { apiLabel, classifyResponse } from './net-monitor';

describe('classifyResponse', () => {
  it('flags a cover-art 404 as a low enhancement', () => {
    const o = classifyResponse({ url: 'http://x/api/cover/abc123def456?token=t', status: 404 });
    expect(o?.kind).toBe('enhancement');
    expect(o?.title).toBe('Cover art 404');
    expect(o?.severity).toBe('low');
    expect(o?.detail).toBe('http://x/api/cover/abc123def456'); // query stripped
  });

  it('flags a non-stream API 404 as a gap', () => {
    const o = classifyResponse({ url: 'http://x/api/library/artists/999', status: 404 });
    expect(o?.kind).toBe('gap');
    expect(o?.title).toContain(':id');
  });

  it('ignores stream 404s (range probes legitimately 404)', () => {
    expect(classifyResponse({ url: 'http://x/api/stream/abc123def456', status: 404 })).toBeNull();
  });

  it('ignores non-API 404s (SPA client routes)', () => {
    expect(classifyResponse({ url: 'http://x/library/missing', status: 404 })).toBeNull();
  });

  it('treats 503 as a low degraded signal, not a crash', () => {
    const o = classifyResponse({ url: 'http://x/api/downloads', status: 503 });
    expect(o?.kind).toBe('degraded');
    expect(o?.severity).toBe('low');
    expect(o?.title).toContain('Service unavailable');
  });

  it('flags a genuine 5xx crash as a high error', () => {
    const o = classifyResponse({ url: 'http://x/api/search', status: 500 });
    expect(o?.kind).toBe('error');
    expect(o?.severity).toBe('high');
  });

  it('flags a slow API call past the threshold', () => {
    const o = classifyResponse(
      { url: 'http://x/api/catalog/search', status: 200, durationMs: 4000 },
      { slowApiMs: 3000 },
    );
    expect(o?.kind).toBe('timing');
    expect(o?.value).toBe(4000);
    const fast = classifyResponse(
      { url: 'http://x/api/catalog/search', status: 200, durationMs: 1000 },
      { slowApiMs: 3000 },
    );
    expect(fast).toBeNull();
  });

  it('returns null for healthy fast responses', () => {
    expect(classifyResponse({ url: 'http://x/api/health', status: 200 })).toBeNull();
  });

  it('threads the flow label through', () => {
    const o = classifyResponse({ url: 'http://x/api/cover/x', status: 404, flow: 'song (§F)' });
    expect(o?.flow).toBe('song (§F)');
  });
});

describe('apiLabel', () => {
  it('strips host, query, and numeric/hash ids', () => {
    expect(apiLabel('https://h/api/library/artists/12345?x=1')).toBe('/api/library/artists/:id');
    expect(apiLabel('https://h/api/cover/abc123def456789')).toBe('/api/cover/:id');
  });
});
