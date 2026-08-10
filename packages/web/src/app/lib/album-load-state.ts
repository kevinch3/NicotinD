import { httpErrorCode } from './http-error';

/**
 * Why an album page has nothing to show. Three outcomes, because they call for
 * three different things from the user:
 *
 * - `processing` — the album exists but is still quarantined (a required
 *   enrichment step hasn't finished). Wait; it will appear on its own. This is
 *   the common case behind a Downloads card's "Open in Library", which is
 *   offered the moment the *download* completes — well before the album lands.
 * - `missing`    — no such album. Go back to the library.
 * - `unavailable`— the request itself failed (server error, auth, offline).
 *   Retrying is meaningful; the album's existence is unknown.
 */
export type AlbumLoadFailure = 'processing' | 'missing' | 'unavailable';

/**
 * Classify a failed `GET /api/library/albums/:id`. Only a 404 says anything
 * about the album itself — every other status is a transport/server problem and
 * must not be reported as "not found". Pure.
 */
export function albumLoadFailureFor(err: unknown): AlbumLoadFailure {
  const status = (err as { status?: number })?.status;
  if (status !== 404) return 'unavailable';
  return httpErrorCode(err) === 'ALBUM_PROCESSING' ? 'processing' : 'missing';
}
