import type { AcquireAlbumDestination } from '@nicotind/core';
import { albumIdFor } from './library-scanner.js';

export type { AcquireAlbumDestination } from '@nicotind/core';

/**
 * Derive the destination album (artist, title, deterministic library album id)
 * from an acquire job's canonical `storage_path` — the `<Artist>/<Album>` dir the
 * organizer placed the files in. Uses the last two path segments (artist, album)
 * so nested/absolute-ish paths still resolve. Returns null when the path can't
 * yield a two-segment album (e.g. a loose single with no album wrapper). Pure.
 */
export function deriveAcquireAlbum(
  storagePath: string | null | undefined,
): AcquireAlbumDestination | null {
  if (!storagePath) return null;
  const segs = storagePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const albumTitle = segs[segs.length - 1]!;
  const albumArtist = segs[segs.length - 2]!;
  return { albumArtist, albumTitle, albumId: albumIdFor(albumArtist, albumTitle) };
}
