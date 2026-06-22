import type { Database } from 'bun:sqlite';
import type { ApplyMetadataRequest } from '@nicotind/core';
import { looksLikeSourceWatermark, isNumericLikeName } from './library-quality.js';
import { isUnknownLike } from './audio-tags.js';

/**
 * "Low-hanging fruit" re-tagger: recover the correct artist/album for pollution
 * that is **real music, just mis-tagged** — the cases the cleanup deliberately
 * does NOT delete. Pure planning (`planRetag`) so it's unit-testable; the script
 * (scripts/retag-pollution.ts) applies each plan through the existing, tested
 * `applyMetadataFix` (which persists a reversible override + re-points the
 * canonical tables, merging duplicates and pruning orphan artists).
 *
 * Two patterns, both recoverable from existing data with no external lookup:
 *   1. **watermark album, real artist** — `<RealArtist>/MUSICAUNO.COM/<Title>`:
 *      the artist is correct, the album field is a DJ-pool watermark. Drop it so
 *      the track becomes a clean single titled by its track name.
 *   2. **numeric-artist mis-split with an embedded "YYYY - Artist - Album" title** —
 *      `101/1968 - Astor Piazzolla - MARÍA DE BUENOS AIRES/<Title>`: parse the real
 *      artist/album/year out of the album title. Every member re-mints to the same
 *      corrected album id, so the fragments **merge** back into one album.
 */

export interface RetagInput {
  artist: string;
  album: string;
  /** The album's single track title (used when collapsing a watermark album → single). */
  songTitle?: string;
  songCount: number;
}

export interface RetagPlan {
  request: ApplyMetadataRequest;
  reason: 'numeric-artist-embedded' | 'watermark-album-to-single';
}

/** "1968 - Astor Piazzolla - MARÍA DE BUENOS AIRES" → year/artist/album. */
const EMBEDDED_RE = /^(\d{4})\s*-\s*(.+?)\s*-\s*(.+)$/;

/**
 * Decide the correction for one album, or null when it isn't a low-hanging-fruit
 * pattern (leave it for the user / other tools). Conservative: never invents data,
 * only re-arranges what's already in the row.
 */
export function planRetag(input: RetagInput): RetagPlan | null {
  const artistNumeric = isNumericLikeName(input.artist);

  // Pattern 2: numeric artist + "YYYY - Artist - Album" album title.
  if (artistNumeric) {
    const m = EMBEDDED_RE.exec(input.album.trim());
    if (m) {
      const year = Number(m[1]);
      const artist = m[2]!.trim();
      const album = m[3]!.trim();
      if (artist && album && !isNumericLikeName(artist)) {
        return {
          request: { artist, album, year, source: 'manual' },
          reason: 'numeric-artist-embedded',
        };
      }
    }
    return null;
  }

  // Pattern 1: watermark album under a real (non-watermark, non-numeric) artist,
  // where the track title is a clean real name. Guard against the *inverted*
  // mis-tag (e.g. "DJ KAIRUZ- SERVICIO ARG" dumps where the title is ALSO the
  // watermark and the real song name sits in the artist field): collapsing to a
  // watermark title would be a no-op that never converges — those are ambiguous
  // junk left to the delete path (`watermark_album`), not re-tagged here.
  if (
    looksLikeSourceWatermark(input.album) &&
    !looksLikeSourceWatermark(input.artist) &&
    input.songCount <= 1 &&
    input.songTitle &&
    !isUnknownLike(input.songTitle) &&
    !looksLikeSourceWatermark(input.songTitle)
  ) {
    return {
      request: { album: input.songTitle.trim(), source: 'manual' },
      reason: 'watermark-album-to-single',
    };
  }

  return null;
}

export interface RetagTarget {
  albumId: string;
  artist: string;
  album: string;
  plan: RetagPlan;
}

/**
 * Scan the library for re-taggable albums and attach a plan to each. Pure read —
 * the caller applies via applyMetadataFix. Uses the album's single song title for
 * the watermark→single collapse.
 */
export function collectRetagTargets(db: Database): RetagTarget[] {
  const albums = db
    .query<
      { id: string; name: string; artist: string; song_count: number },
      []
    >('SELECT id, name, artist, song_count FROM library_albums')
    .all();
  const out: RetagTarget[] = [];
  for (const al of albums) {
    const songTitle =
      db
        .query<
          { title: string },
          [string]
        >('SELECT title FROM library_songs WHERE album_id = ? LIMIT 1')
        .get(al.id)?.title ?? undefined;
    const plan = planRetag({
      artist: al.artist,
      album: al.name,
      songTitle,
      songCount: al.song_count,
    });
    if (plan) out.push({ albumId: al.id, artist: al.artist, album: al.name, plan });
  }
  return out;
}
