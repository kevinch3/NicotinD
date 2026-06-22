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
}

/**
 * Map a failed hunt-download call to an outcome. The server rejects a duplicate
 * acquisition with 409 + a machine code in `{ error: { error } }`; those are
 * positive notices, not red errors. Everything else (502 offline peer, etc.)
 * falls through to a generic error message.
 */
export function classifyHuntDownloadError(err: unknown): HuntDownloadErrorOutcome {
  const code = (err as { error?: { error?: string } })?.error?.error;
  if (code === 'already-complete') return { kind: 'already-complete', message: '' };
  if (code === 'already-downloading') return { kind: 'already-downloading', message: '' };
  return { kind: 'error', message: err instanceof Error ? err.message : 'Download failed' };
}
