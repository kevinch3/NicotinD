import { describe, expect, it } from 'bun:test';
import {
  classifyConsoleMessage,
  classifyPageError,
  classifyRequestFailure,
} from './console-monitor';

describe('classifyConsoleMessage', () => {
  it('flags a console.error as a high-severity error', () => {
    const o = classifyConsoleMessage({ type: 'error', text: 'TypeError: x is undefined', flow: 'f' });
    expect(o).not.toBeNull();
    expect(o?.kind).toBe('error');
    expect(o?.severity).toBe('high');
    expect(o?.flow).toBe('f');
    expect(o?.detail).toContain('TypeError');
  });

  it('flags a console.warning as a low-severity enhancement', () => {
    const o = classifyConsoleMessage({ type: 'warning', text: 'deprecated API used' });
    expect(o?.kind).toBe('enhancement');
    expect(o?.severity).toBe('low');
    expect(o?.flow).toBe('global');
  });

  it('ignores plain logs and empty messages', () => {
    expect(classifyConsoleMessage({ type: 'log', text: 'hello' })).toBeNull();
    expect(classifyConsoleMessage({ type: 'error', text: '   ' })).toBeNull();
  });

  it('drops known environmental noise even at error level', () => {
    expect(classifyConsoleMessage({ type: 'error', text: 'autoplay was prevented' })).toBeNull();
    expect(
      classifyConsoleMessage({ type: 'warning', text: 'Failed to load source map for x' }),
    ).toBeNull();
    expect(
      classifyConsoleMessage({ type: 'error', text: 'GET /favicon.ico 404' }),
    ).toBeNull();
    // The browser's generic HTTP-failure echo is left to the response classifier.
    expect(
      classifyConsoleMessage({
        type: 'error',
        text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      }),
    ).toBeNull();
  });

  it('truncates very long messages to keep the report readable', () => {
    const long = 'E'.repeat(500);
    const o = classifyConsoleMessage({ type: 'error', text: long });
    expect((o?.detail ?? '').length).toBeLessThanOrEqual(301);
    expect(o?.detail?.endsWith('…')).toBe(true);
  });
});

describe('classifyPageError', () => {
  it('flags an uncaught error high', () => {
    const o = classifyPageError({ message: 'ReferenceError: foo is not defined', flow: 'g' });
    expect(o?.kind).toBe('error');
    expect(o?.severity).toBe('high');
    expect(o?.title).toBe('Uncaught page error');
  });

  it('ignores noise and empties', () => {
    expect(classifyPageError({ message: '' })).toBeNull();
    expect(classifyPageError({ message: 'chrome-extension://abc threw' })).toBeNull();
  });
});

describe('classifyRequestFailure', () => {
  it('ignores benign aborted/cancelled requests', () => {
    expect(
      classifyRequestFailure({ url: 'http://x/api/search?q=a', errorText: 'net::ERR_ABORTED' }),
    ).toBeNull();
  });

  it('flags a genuine request failure as an error', () => {
    const o = classifyRequestFailure({ url: 'http://x/api/library/albums', errorText: 'net::ERR_FAILED' });
    expect(o?.kind).toBe('error');
    expect(o?.severity).toBe('high');
    expect(o?.detail).toContain('/api/library/albums');
    expect(o?.detail).not.toContain('?');
  });

  it('treats a failed cover request as a low enhancement, not an error', () => {
    const o = classifyRequestFailure({ url: 'http://x/api/cover/abc123', errorText: 'net::ERR_FAILED' });
    expect(o?.kind).toBe('enhancement');
    expect(o?.severity).toBe('low');
  });
});
