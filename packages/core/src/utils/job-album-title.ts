/**
 * Filing metadata for a URL acquisition: which album, if any, this job is for.
 *
 * The addon protocol keeps `title` and `album` apart on purpose — `title` is
 * the card's *display* name, and letting it fall back into `album_title` would
 * mint a phantom album out of a playlist name and mis-file every track in it
 * (see `DownloadTitleInput.displayTitle`). That separation is right, and this
 * function is its one narrow exception rather than a repeal of it.
 *
 * The exception holds when the pasted link *is* one release: a non-playlist
 * album URL names exactly one album, so whatever the addon called the job is
 * that album's name. Measured on prod before it was written — all five Spotify
 * album acquires carried the release name in `display_title` ("Espejitos",
 * "Crece", "Alabanza", "Made In Jamaica", "Gondwana") and none carried an
 * `album_title` at all, while both genuine playlists were excluded by
 * `isPlaylist`.
 *
 * Why it matters: with no `album_title`, `LibraryOrganizer.applyJobCanonicalName`
 * declines to stamp the ALBUM tag, tagless files land in a shared
 * `<Artist>/Unknown/` bucket, and the scanner's loose-single rule — correct for
 * a genuine stray track — rewrites each file's album to its own *title*. One
 * 13-track release became twelve albums that way (issue #997).
 *
 * Returns `null` to mean "change nothing", never a guess.
 */
import { classifyAcquireUrl } from '../types/classify-acquire-url.js';
import { isUnknownLike } from './unknown-like.js';

export interface JobAlbumTitleInput {
  /** The link the user pasted. */
  sourceUrl?: string | null;
  /** The addon's display name for the job. */
  displayTitle?: string | null;
  /** Already-known filing metadata — present means there is nothing to infer. */
  albumTitle?: string | null;
  /** Whether this acquisition was resolved as a playlist. */
  isPlaylist?: boolean;
}

export function albumTitleForUrlJob(input: JobAlbumTitleInput): string | null {
  // First writer wins, matching the COALESCE the addon poller already applies:
  // an addon that reports a real album is always more authoritative than this.
  if (!isUnknownLike(input.albumTitle)) return null;
  if (input.isPlaylist) return null;
  if (!input.sourceUrl) return null;
  if (classifyAcquireUrl(input.sourceUrl).kind !== 'album') return null;

  const display = (input.displayTitle ?? '').trim();
  // A placeholder promoted into filing metadata just restates the problem in a
  // different column — it is what the tags already said.
  if (isUnknownLike(display)) return null;
  return display;
}
