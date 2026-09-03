import { AUDIO_EXTENSIONS, extensionOf } from './audio-extensions.js';

/**
 * What a browser upload is allowed to send (docs/import.md).
 *
 * Shared rather than duplicated because it runs on both sides for different
 * reasons: the client filters to avoid spending the user's bandwidth on files
 * the library would ignore, and the server enforces because a client's word is
 * not a permission. Two copies of this list would drift into "the browser
 * uploaded it and the server threw it away", which looks like data loss.
 *
 * Deliberately narrower than `AUDIO_EXTENSIONS` alone: cover art rides along
 * because the organizer and scanner both read it and it is small, but only
 * under the conventional filenames. A folder of holiday photos that happens to
 * sit beside an album is not album art.
 */
const COVER_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const COVER_STEMS: ReadonlySet<string> = new Set(['cover', 'folder', 'front', 'album', 'artwork']);

/**
 * Whether a manifest entry is worth uploading. Takes a path but judges only its
 * basename, so a dot-prefixed *directory* does not disqualify the music inside
 * it.
 *
 * The dot-prefix rule is load-bearing, not hygiene: macOS AppleDouble sidecars
 * are named `._Track.flac`, so an extension-only test happily uploads a 4 KB
 * resource fork as though it were the song.
 */
export function isUploadableName(relPath: string): boolean {
  const basename = relPath.split('/').pop() ?? '';
  if (!basename || basename.startsWith('.')) return false;
  const ext = extensionOf(basename);
  if (AUDIO_EXTENSIONS.has(ext)) return true;
  if (!COVER_EXTENSIONS.has(ext)) return false;
  return COVER_STEMS.has(basename.slice(0, basename.length - ext.length).toLowerCase());
}
