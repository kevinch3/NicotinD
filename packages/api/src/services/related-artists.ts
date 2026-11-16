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
import { culturalNeighbours, relationshipNeighbours } from './artist-relations.js';
import type { MbRelationshipKind } from './musicbrainz-client.js';

export const RELATED_LIMIT_DEFAULT = 12;
export const RELATED_LIMIT_MAX = 24;

/** How many top candidates each source contributes before visibility and ranking. */
const SOURCE_POOL = 60;

/** Per-source evidence for one candidate; a source that has nothing to say is absent. */
export interface RelatedSignals {
  audio?: Omit<AudioNeighbour, 'id'>;
  /** Shared listeners (#1486): 0–1 against the seed's strongest relation. */
  cultural?: { score: number; source: string };
  /** A stated link (#1486): a member, a collaboration, a supporting musician. */
  relationship?: { kind: MbRelationshipKind; source: string };
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
 * Places at the front of the row for stated relationships. They are facts, not
 * a score, so they cannot be ranked against a cosine; a small fixed number
 * shows them without letting a long member list push the sound-alikes out.
 */
export const RELATIONSHIP_SLOTS = 3;

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
  const stated = candidates
    .filter((c) => c.signals.relationship)
    .slice(0, Math.min(RELATIONSHIP_SLOTS, limit))
    .map((c) => ({ id: c.id, score: 1 }));
  const statedIds = new Set(stated.map((c) => c.id));
  limit -= stated.length;
  if (limit <= 0) return stated;
  candidates = candidates.filter((c) => !statedIds.has(c.id));
  const ranked = rankBySound(candidates, limit);
  return [...stated, ...ranked];
}

function rankBySound(
  candidates: readonly RelatedCandidate[],
  limit: number,
): { id: string; score: number }[] {
  const scored = candidates
    .filter((c) => c.signals.audio)
    .map((c) => ({ id: c.id, score: c.signals.audio!.cosine }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  const byAudio = scored
    .filter((c) => c.score >= MIN_RELATED_COSINE && c.score >= best - RELATED_RELATIVE_CUT)
    .slice(0, limit);
  if (byAudio.length >= limit) return byAudio;
  // The two scales are not comparable (a cosine against a share of listeners)
  // and nothing has calibrated one against the other, so they are not mixed:
  // audio ranks first, as before, and shared listeners fill the places audio
  // left empty. That is the long tail: an artist with too few analysed tracks.
  const taken = new Set(byAudio.map((c) => c.id));
  const byCulture = candidates
    .filter((c) => c.signals.cultural && !taken.has(c.id))
    .map((c) => ({ id: c.id, score: c.signals.cultural!.score }))
    .sort((a, b) => b.score - a.score);
  return [...byAudio, ...byCulture].slice(0, limit);
}

export interface RelatedArtist {
  id: string;
  name: string;
  coverArt: string | null;
  /** The artist's `cover_rev` (#1666): moves when the portrait's bytes do. */
  coverRev: number;
  albumCount: number;
  score: number;
  /** Which sources backed this pick, and with what — the "why" a tile can show. */
  signals: RelatedSignals;
}

/** A related artist the library does not have: the discovery hook (#1486). */
export interface NotOwnedRelatedArtist {
  mbid: string;
  name: string;
  /** 0–1, relative to the seed's strongest relation. */
  score: number;
}

/** How many not-owned related artists a page is offered. */
export const NOT_OWNED_LIMIT = 8;

export type RelatedArtistsResult = (
  | { artists: RelatedArtist[] }
  /** No source has anything on the seed (today: fewer than the floor of analysed tracks). */
  | { artists: []; reason: 'no-signal' }
) & {
  /** Present only when there are some; listener data is the one source that names them. */
  notOwned?: NotOwnedRelatedArtist[];
};

/** The strongest related artists that are not in the library, best first. */
export function notOwnedRelated(db: Database, artistId: string): NotOwnedRelatedArtist[] {
  return (culturalNeighbours(db, artistId, SOURCE_POOL) ?? [])
    .filter((n) => n.id === null)
    .slice(0, NOT_OWNED_LIMIT)
    .map((n) => ({ mbid: n.mbid, name: n.name, score: n.score }));
}

/** Merge every source's candidates by artist id, keeping first-seen order. */
function gather(db: Database, artistId: string): Map<string, RelatedSignals> | null {
  const merged = new Map<string, RelatedSignals>();
  let anySource = false;
  // Stated relationships first: insertion order is what `rankRelated` reads.
  const stated = relationshipNeighbours(db, artistId);
  if (stated.length > 0) {
    anySource = true;
    for (const n of stated) {
      merged.set(n.id, { relationship: { kind: n.kind, source: 'musicbrainz' } });
    }
  }
  const audio = audioNeighbours(db, artistId, SOURCE_POOL);
  if (audio) {
    anySource = true;
    for (const { id, ...signal } of audio) {
      merged.set(id, { ...merged.get(id), audio: signal });
    }
  }
  const cultural = culturalNeighbours(db, artistId, SOURCE_POOL);
  if (cultural) {
    anySource = true;
    for (const n of cultural) {
      if (!n.id) continue;
      merged.set(n.id, {
        ...merged.get(n.id),
        cultural: { score: n.score, source: n.source },
      });
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
  const found = notOwnedRelated(db, artistId);
  const discovery = found.length ? { notOwned: found } : {};
  merged.delete(artistId);
  if (merged.size === 0) return { artists: [], ...discovery };

  const ids = [...merged.keys()];
  const rows = db
    .query<
      {
        id: string;
        name: string;
        cover_art: string | null;
        album_count: number;
        cover_rev: number;
      },
      string[]
    >(
      `SELECT id, name, cover_art, album_count, cover_rev FROM library_artists
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
        coverRev: r.cover_rev,
        albumCount: r.album_count,
        score,
        signals: merged.get(id)!,
      };
    }),
    ...discovery,
  };
}
