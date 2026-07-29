import { captureError, connectErrorSink, _resetErrorBuffer } from './error-buffer';

describe('error-buffer (issue #285)', () => {
  beforeEach(() => _resetErrorBuffer());

  it('buffers errors before a sink connects, then replays them in order', () => {
    const seen: unknown[] = [];
    captureError('a', 'window');
    captureError('b', 'angular');
    // Nothing reported yet — the SDK has not loaded.
    expect(seen).toEqual([]);

    connectErrorSink((e) => seen.push(e.error));
    expect(seen).toEqual(['a', 'b']);
  });

  it('forwards immediately once a sink is connected', () => {
    const seen: unknown[] = [];
    connectErrorSink((e) => seen.push(e.error));
    captureError('c');
    expect(seen).toEqual(['c']);
  });

  it('empties the buffer on connect so a re-connect does not double-report', () => {
    captureError('once');
    const first: unknown[] = [];
    connectErrorSink((e) => first.push(e.error));
    expect(first).toEqual(['once']);

    const second: unknown[] = [];
    connectErrorSink((e) => second.push(e.error));
    // The buffer was drained by the first connect; the second sees nothing.
    expect(second).toEqual([]);
  });

  it('bounds the buffer so a startup error storm cannot grow it unbounded', () => {
    for (let i = 0; i < 100; i++) captureError(i);
    const seen: unknown[] = [];
    connectErrorSink((e) => seen.push(e.error));
    expect(seen).toHaveLength(50);
    // Keeps the first (most useful) errors rather than the tail.
    expect(seen[0]).toBe(0);
    expect(seen[49]).toBe(49);
  });
});
