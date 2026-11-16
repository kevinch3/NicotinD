/**
 * What the organizer does to an artist or album tag before it becomes part of
 * a file's identity. A leaf module so that read-only measurements (the audit,
 * the health report) can ask "what would this tag become" without importing
 * the organizer.
 */
import {
  isTrackNumberFragment,
  looksLikeFilenameTag,
  stripArtistLeadJunk,
  stripFeaturingSuffix,
  stripTrackPrefix,
} from './path-sanitize.js';
import {
  djSetArtistName,
  looksLikeDjSetTag,
  looksLikeSourceWatermark,
  looksLikeVenueCredit,
} from './library-quality.js';

/**
 * Some peers tag tracks with `"01. Artist Name"` / `"03) Artist"` etc.
 * Strip a leading track-number prefix; if the value is *only* a track number,
 * discard it entirely (returns undefined). Also returns undefined for the
 * literal extension form, since that means the tag was a filename.
 */
export function sanitizeArtistTag(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (isTrackNumberFragment(raw)) return undefined;
  // DJ-pool / VA-source watermark tagged as the artist (e.g. "ftpdjemilio.com",
  // "DJ KAIRUZ- SERVICIO ARG"): never a real artist — drop so it doesn't mint a
  // junk artist row. This is the ingest half of the library auditor's
  // `watermark_artist` rule (see docs/library-audit.md).
  if (looksLikeSourceWatermark(raw)) return undefined;
  let v = stripTrackPrefix(raw);
  if (!v) return undefined;
  v = stripArtistLeadJunk(v);
  v = stripFeaturingSuffix(v);
  if (!v || isTrackNumberFragment(v) || looksLikeSourceWatermark(v)) return undefined;
  // A whole DJ-set / release-listing line in the artist tag (issue #679).
  // Recover the leading credit when it is unambiguous — dropping instead would
  // strand the track in Unsorted and throw away the real artist the string
  // carried. An ambiguous credit (a `b2b` set names two acts) recovers nothing
  // and is dropped rather than guessed at.
  const recovered = djSetArtistName(v);
  if (recovered) return recovered;
  if (looksLikeDjSetTag(v) || looksLikeVenueCredit(v)) return undefined;
  return v;
}

/**
 * Drop album values that are actually filename leakage (`"01 - Track.mp3"`)
 * or pure track-number fragments. Real albums occasionally have leading
 * numbers (e.g. `"1989"`) — we only reject when there's also a track-style
 * separator or audio extension.
 */
export function sanitizeAlbumTag(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (looksLikeFilenameTag(raw)) return undefined;
  if (isTrackNumberFragment(raw)) return undefined;
  // Source watermark in the album field ("MUSICAUNO.COM", "ftpdjemilio.com"):
  // drop so the track buckets by its real album/single instead of a junk one.
  if (looksLikeSourceWatermark(raw)) return undefined;
  // A DJ-set tracklist line or a release-listing row is not a release title
  // (issue #679). `looksLikeVenueCredit` is deliberately NOT applied here:
  // "Live @ Wembley" is a real album title.
  if (looksLikeDjSetTag(raw)) return undefined;
  return raw;
}
