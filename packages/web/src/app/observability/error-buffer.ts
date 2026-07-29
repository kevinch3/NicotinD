/**
 * A tiny synchronous error buffer that preserves startup-error capture while the
 * Sentry SDK is loaded lazily (issue #285). The SDK is ~272 kB — 42 % of the
 * initial chunk, mostly Session Replay — so it is dynamically imported *after*
 * first paint rather than eagerly before bootstrap. Until it connects, every
 * error (including a bootstrap failure) is recorded here and replayed the moment
 * it does, so nothing thrown early is lost. This buffer is the one piece that
 * keeps the "capture startup failures" property the old eager init existed for.
 */
export interface CapturedError {
  error: unknown;
  /** Where the error came from — window.onerror, a rejection, Angular, bootstrap. */
  context: string;
}

/** Bounded so a storm during a broken startup can't grow the buffer unbounded. */
const MAX_BUFFERED = 50;
const buffer: CapturedError[] = [];
let sink: ((e: CapturedError) => void) | null = null;

/**
 * Record an error. Forwards immediately once the SDK has connected; otherwise
 * buffers it (up to the bound, then drops — the first errors are the useful ones).
 */
export function captureError(error: unknown, context = 'window'): void {
  if (sink) {
    sink({ error, context });
    return;
  }
  if (buffer.length < MAX_BUFFERED) buffer.push({ error, context });
}

/**
 * Connect the real reporter — called once `Sentry.init` has run. Drains the
 * buffer and forwards every future capture. A second connect just replaces the
 * sink (the buffer is already empty by then).
 */
export function connectErrorSink(next: (e: CapturedError) => void): void {
  sink = next;
  const pending = buffer.splice(0, buffer.length);
  for (const e of pending) next(e);
}

/**
 * Install global listeners for the pre-bootstrap window, before Angular's own
 * `provideBrowserGlobalErrorListeners` is active. Returns a cleanup that removes
 * them — call it once bootstrap settles so runtime errors aren't double-reported
 * (Angular's ErrorHandler → BufferingErrorHandler takes over from there).
 */
export function installStartupErrorCapture(): () => void {
  const onError = (e: ErrorEvent): void => captureError(e.error ?? e.message, 'window.onerror');
  const onRejection = (e: PromiseRejectionEvent): void =>
    captureError(e.reason, 'unhandledrejection');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Test-only reset of module state. */
export function _resetErrorBuffer(): void {
  buffer.length = 0;
  sink = null;
}
