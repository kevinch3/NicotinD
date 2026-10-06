/**
 * Related artists — the source-agnostic half (docs/related-artists.md).
 *
 * Each SOURCE answers "which artists relate to this one, and how strongly, by
 * my measure" and knows nothing of the others. Today there is one: audio
 * (`artist-centroids.ts`). Cultural relations from ListenBrainz / MusicBrainz
 * (#1486) are the planned second, stored locally and read here the same way —
 * a new key on `RelatedSignals`, a new gather step, and `rankRelated` decides
 * how they blend. Nothing in the route or the client changes shape for it.
 */

import type { Database } from 'bun:sqlite';
import { audioNeighbours, MIN_RELATED_COSINE, type AudioNeighbour } from './artist-centroids.js';

export const RELATED_LIMIT_DEFAULT = 12;
export const RELATED_LIMIT_MAX = 24;

/** How many top candidates each source contributes before visibility and ranking. */
const SOURCE_POOL = 60;

/** Per-source evidence for one candidate; a source that has nothing to say is absent. */
export interface RelatedSignals {
  audio?: Omit<AudioNeighbour, 'id'>;
}

export interface RelatedCandidate {
  id: string;
  signals: RelatedSignals;
}

/**
 * How far below the seed's own best match a pick may sit. 0.08 dropped correct
 * cumbia picks from a cuarteto seed's row on prod; 0.1 kept them and still cut
 * the stragglers (docs/related-artists.md "Ranking").
 */
export const RELATED_RELATIVE_CUT = 0.1;

/**
 * Turn the visible candidates for one artist into the row the page shows:
 * which survive and in what order. Candidates arrive in the order the sources
 * produced them (audio: cosine, highest first), the seed already excluded.
 *
 * Relative to the seed's best match, not absolute: a thin seed depresses all
 * its cosines alike, so only the gap is comparable across artists. No member
 * discount — a thin candidate already scores low (measured ~0.2/n).
 */
export function rankRelated(
  candidates: readonly RelatedCandidate[],
  limit: number,
): { id: string; score: number }[] {
  const scored = candidates
    .filter((c) => c.signals.audio)
    .map((c) => ({ id: c.id, score: c.signals.audio!.cosine }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((c) => c.score >= MIN_RELATED_COSINE && c.score >= best - RELATED_RELATIVE_CUT)
    .slice(0, limit);
}

export interface RelatedArtist {
  id: string;
  name: string;
  coverArt: string | null;
  albumCount: number;
  score: number;
  /** Which sources backed this pick, and with what — the "why" a tile can show. */
  signals: RelatedSignals;
}

export type RelatedArtistsResult =
  | { artists: RelatedArtist[] }
  /** No source has anything on the seed (today: fewer than the floor of analysed tracks). */
  | { artists: []; reason: 'no-signal' };

/** Merge every source's candidates by artist id, keeping first-seen order. */
function gather(db: Database, artistId: string): Map<string, RelatedSignals> | null {
  const merged = new Map<string, RelatedSignals>();
  let anySource = false;
  const audio = audioNeighbours(db, artistId, SOURCE_POOL);
  if (audio) {
    anySource = true;
    for (const { id, ...signal } of audio) {
      merged.set(id, { ...merged.get(id), audio: signal });
    }
  }
  return anySource ? merged : null;
}

/**
 * The library artists related to `artistId`. Hidden, compound and fragment
 * artist rows are filtered here, once for every source, at read time — so a
 * curator's hide shows on the next request rather than the next rebuild.
 */
export function relatedArtists(
  db: Database,
  artistId: string,
  limit = RELATED_LIMIT_DEFAULT,
): RelatedArtistsResult {
  const merged = gather(db, artistId);
  if (!merged) return { artists: [], reason: 'no-signal' };
  merged.delete(artistId);
  if (merged.size === 0) return { artists: [] };

  const ids = [...merged.keys()];
  const rows = db
    .query<{ id: string; name: string; cover_art: string | null; album_count: number }, string[]>(
      `SELECT id, name, cover_art, album_count FROM library_artists
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND hidden = 0 AND split_compound = 0 AND fragment_of IS NULL`,
    )
    .all(...ids);
  const visible = new Map(rows.map((r) => [r.id, r]));

  const candidates = ids
    .filter((id) => visible.has(id))
    .map((id) => ({ id, signals: merged.get(id)! }));
  return {
    artists: rankRelated(candidates, limit).map(({ id, score }) => {
      const r = visible.get(id)!;
      return {
        id,
        name: r.name,
        coverArt: r.cover_art,
        albumCount: r.album_count,
        score,
        signals: merged.get(id)!,
      };
    }),
  };
}
