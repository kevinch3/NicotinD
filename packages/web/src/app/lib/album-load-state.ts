/**
 * Why an album page has nothing to show. Two outcomes, because they call for
 * two different things from the user:
 *
 * - `missing`    — no such album. Go back to the library.
 * - `unavailable`— the request itself failed (server error, auth, offline).
 *   Retrying is meaningful; the album's existence is unknown.
 */
export type AlbumLoadFailure = 'missing' | 'unavailable';

/**
 * Classify a failed `GET /api/library/albums/:id`. Only a 404 says anything
 * about the album itself — every other status is a transport/server problem and
 * must not be reported as "not found". Pure.
 */
export function albumLoadFailureFor(err: unknown): AlbumLoadFailure {
  const status = (err as { status?: number })?.status;
  return status === 404 ? 'missing' : 'unavailable';
}
