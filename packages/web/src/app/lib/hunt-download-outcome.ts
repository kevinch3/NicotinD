// Pure decision logic for the album-hunt download result/error → modal outcome.
//
// Kept DI-free (no Angular) so it's unit-testable: the JIT vitest harness can't
// drive the modal's `input()` signals, so the branching lives here and the
// component just renders the outcome. See AlbumHuntModalComponent.downloadSelected().

/** The two server-success shapes for POST .../hunt-download. */
export interface HuntDownloadResult {
  queued: number;
  // True when every chosen file was already on disk (200, queued 0) — nothing
  // was actually enqueued.
  alreadyComplete?: boolean;
}

/**
 * A genuine `queued` download closes the modal & refreshes the library; an
 * `already-complete` result is a positive "you already have it" notice, not a
 * silent close.
 */
export function classifyHuntDownloadResult(res: HuntDownloadResult): 'queued' | 'already-complete' {
  return res.alreadyComplete === true || res.queued === 0 ? 'already-complete' : 'queued';
}

export type HuntDownloadErrorKind = 'already-complete' | 'already-downloading' | 'error';

export interface HuntDownloadErrorOutcome {
  kind: HuntDownloadErrorKind;
  // Only meaningful for `kind: 'error'`; the dedicated states carry their own copy.
  message: string;
  /**
   * Whether trying a *different* candidate could plausibly succeed. A 5xx (peer
   * offline / addon hiccup) or a network failure is a per-attempt condition; a
   * 4xx (stale selection, validation) will fail identically for every peer.
   */
  retriable: boolean;
}

/**
 * Map a failed hunt-download call to an outcome. The server rejects a duplicate
 * acquisition with 409 + a machine code in `{ error: { error } }`; those are
 * positive notices, not red errors. Any other body `error` string is the
 * server's human-readable reason and is surfaced verbatim (issue #531 — the
 * generic fallback used to hide "Selection expired…" and made #530
 * undiagnosable from the toast).
 */
export function classifyHuntDownloadError(err: unknown): HuntDownloadErrorOutcome {
  const code = (err as { error?: { error?: string } })?.error?.error;
  if (code === 'already-complete')
    return { kind: 'already-complete', message: '', retriable: false };
  if (code === 'already-downloading')
    return { kind: 'already-downloading', message: '', retriable: false };
  const status = (err as { status?: number })?.status;
  const retriable = status === 0 || (typeof status === 'number' && status >= 500);
  const message =
    (typeof code === 'string' && code) || (err instanceof Error ? err.message : 'Download failed');
  return { kind: 'error', message, retriable };
}
