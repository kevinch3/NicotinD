/**
 * Recovery for a lazy route whose chunk no longer exists (#925).
 *
 * A tab left open across a deploy holds a build whose chunk hashes are gone.
 * The next lazy navigation asks for a file the server no longer has, and the
 * route simply dies — the user clicks a link and nothing happens.
 *
 * Reloading pulls the current build and the navigation succeeds. The whole
 * subtlety is doing that exactly once: if the chunk is genuinely missing rather
 * than merely stale, a reload finds it missing again, and an unguarded retry is
 * an unbounded refresh loop that looks far worse than the original dead button.
 */

/** Marks that we already spent our one reload, so a broken build cannot loop. */
export const STALE_CHUNK_MARKER = 'nicotind-stale-chunk-reload';

/**
 * Whether this error is "the chunk is gone" rather than "the component threw".
 *
 * Matched on the browser's own wording for a failed dynamic import. Deliberately
 * narrow: an error from *inside* a successfully-loaded component is a real bug,
 * and reloading would hide it behind a refresh.
 */
export function isStaleChunkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('error loading chunk')
  );
}

/**
 * Reload once to pick up the current build. Returns whether a reload was
 * actually started, so the caller can rethrow when it was not.
 *
 * `sessionStorage` rather than `localStorage`: the marker should die with the
 * tab. A user who hits this today should not be denied a recovery next week.
 */
export function recoverStaleChunk(
  reload: () => void,
  store: Storage | undefined = globalThis.sessionStorage,
): boolean {
  try {
    if (store?.getItem(STALE_CHUNK_MARKER)) return false;
    store?.setItem(STALE_CHUNK_MARKER, '1');
  } catch {
    // Storage can be unavailable (private mode, blocked site data). Losing the
    // guard is worse than losing the recovery, so decline rather than risk a
    // loop we cannot detect.
    return false;
  }
  reload();
  return true;
}

/** Clear the marker once the app is running, so the next stale build recovers too. */
export function clearStaleChunkMarker(
  store: Storage | undefined = globalThis.sessionStorage,
): void {
  try {
    store?.removeItem(STALE_CHUNK_MARKER);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

/**
 * Wrap a lazy route loader so a stale chunk reloads instead of dying.
 *
 * The returned promise never resolves on the recovery path — the page is being
 * replaced, and resolving would let the router continue against a document
 * that is going away.
 */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((err: unknown) => {
      if (isStaleChunkError(err) && recoverStaleChunk(() => location.reload())) {
        return new Promise<T>(() => {});
      }
      throw err;
    });
}
