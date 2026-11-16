import type { Database } from 'bun:sqlite';
import { normalizeArtistForGrouping } from './album-grouping.js';
import type { SimilarArtist } from './listenbrainz-client.js';
import type { MbArtistRelationship, MbRelationshipKind } from './musicbrainz-client.js';

/**
 * Cultural artist relations (#1486, docs/artist-relations.md): the non-audio
 * signal. Audio similarity knows two artists sound alike; it cannot know they
 * share listeners. ListenBrainz's similar-artists data does, and it is fetched
 * once per artist MBID by an enrichment task and read from here.
 */
export const RELATION_SOURCE = 'listenbrainz';
/** The source of stated relationships: member, collaboration, supporting musician. */
export const RELATIONSHIP_SOURCE = 'musicbrainz';
/** Ask a source again about an artist this often. Listening habits drift slowly. */
export const RELATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** A relation weaker than this share of the artist's best one is not offered. */
export const RELATION_MIN_SCORE = 0.05;

/**
 * Replace what `source` says about `sourceMbid` with `results`, and record that
 * it was asked. `score` is each raw score over the best one, so the best
 * relation of every artist is 1 and scores compare across artists.
 */
export function storeSimilarArtists(
  db: Database,
  sourceMbid: string,
  results: readonly SimilarArtist[],
  now = Date.now(),
): void {
  const top = results.reduce((m, r) => Math.max(m, r.score), 0);
  db.transaction(() => {
    db.run(
      `DELETE FROM library_artist_relations WHERE source_mbid = ? AND kind = 'similar' AND source = ?`,
      [sourceMbid, RELATION_SOURCE],
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO library_artist_relations
         (source_mbid, target_mbid, target_name, kind, score, raw_score, source, fetched_at)
       VALUES (?, ?, ?, 'similar', ?, ?, ?, ?)`,
    );
    for (const r of results) {
      insert.run(
        sourceMbid,
        r.mbid,
        r.name,
        top > 0 ? r.score / top : 0,
        r.score,
        RELATION_SOURCE,
        now,
      );
    }
    db.run(
      `INSERT INTO library_artist_relation_fetches (mbid, source, fetched_at, results)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(mbid, source) DO UPDATE SET fetched_at = excluded.fetched_at, results = excluded.results`,
      [sourceMbid, RELATION_SOURCE, now, results.length],
    );
  })();
}

/**
 * Library artists and their usable MusicBrainz ids, both ways. `library_mbids`
 * is keyed by the artist's normalized name, not its id, and a curator's
 * tombstone (`source = 'user'`, confidence 0) is not an id anyone may use.
 */
export function artistMbidIndex(db: Database): {
  mbidOf: Map<string, string>;
  artistOf: Map<string, string>;
} {
  const byKey = new Map<string, string>();
  for (const r of db
    .query<{ key: string; mbid: string }, []>(
      `SELECT key, mbid FROM library_mbids
        WHERE scope = 'artist' AND mbid <> '' AND NOT (source = 'user' AND confidence = 0)`,
    )
    .all()) {
    byKey.set(r.key, r.mbid);
  }
  const mbidOf = new Map<string, string>();
  const artistOf = new Map<string, string>();
  for (const a of db
    .query<{ id: string; name: string }, []>(
      `SELECT id, name FROM library_artists
        WHERE hidden = 0 AND split_compound = 0 AND fragment_of IS NULL
        ORDER BY album_count DESC, name`,
    )
    .all()) {
    const mbid = byKey.get(normalizeArtistForGrouping(a.name));
    if (!mbid) continue;
    mbidOf.set(a.id, mbid);
    // Two spellings of one artist share an MBID; the larger one (first) keeps it.
    if (!artistOf.has(mbid)) artistOf.set(mbid, a.id);
  }
  return { mbidOf, artistOf };
}

/** Library artists with an MBID that `source` has not been asked about since `cutoff`. */
export function pendingRelationArtists(
  db: Database,
  cutoff: number,
  limit?: number,
  source: string = RELATION_SOURCE,
): Array<{ id: string; mbid: string }> {
  const fresh = new Set(
    db
      .query<{ mbid: string }, [string, number]>(
        `SELECT mbid FROM library_artist_relation_fetches WHERE source = ? AND fetched_at > ?`,
      )
      .all(source, cutoff)
      .map((r) => r.mbid),
  );
  const out: Array<{ id: string; mbid: string }> = [];
  const seen = new Set<string>();
  for (const [id, mbid] of artistMbidIndex(db).mbidOf) {
    if (fresh.has(mbid) || seen.has(mbid)) continue;
    seen.add(mbid);
    out.push({ id, mbid });
    if (limit != null && out.length >= limit) break;
  }
  return out;
}

export interface CulturalNeighbour {
  /** The library artist, or null when the related artist is not owned. */
  id: string | null;
  mbid: string;
  name: string;
  /** 0–1, relative to the seed's strongest relation. */
  score: number;
  source: string;
}

/**
 * Who listeners of `artistId` also listen to, best first: owned artists with
 * their library id, the rest by MBID and name (the discovery pool). Null when
 * the artist has no MBID or the source has not been asked yet, which is not the
 * same as an empty list (asked, nothing known).
 */
export function culturalNeighbours(
  db: Database,
  artistId: string,
  limit: number,
): CulturalNeighbour[] | null {
  const { mbidOf, artistOf } = artistMbidIndex(db);
  const mbid = mbidOf.get(artistId);
  if (!mbid) return null;
  const asked = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM library_artist_relation_fetches WHERE mbid = ? AND source = ?`,
    )
    .get(mbid, RELATION_SOURCE);
  if (!asked?.n) return null;
  return db
    .query<
      { target_mbid: string; target_name: string; score: number; source: string },
      [string, number, number]
    >(
      `SELECT target_mbid, target_name, score, source FROM library_artist_relations
        WHERE source_mbid = ? AND kind = 'similar' AND score >= ?
        ORDER BY score DESC, target_name LIMIT ?`,
    )
    .all(mbid, RELATION_MIN_SCORE, limit)
    .map((r) => ({
      id: artistOf.get(r.target_mbid) ?? null,
      mbid: r.target_mbid,
      name: r.target_name,
      score: r.score,
      source: r.source,
    }))
    .filter((n) => n.id !== artistId);
}

/**
 * Store one artist's stated relationships (MusicBrainz), replacing what was
 * stored for it. An empty answer is recorded too, as for similar artists.
 */
export function storeArtistRelationships(
  db: Database,
  sourceMbid: string,
  relationships: readonly MbArtistRelationship[],
  now = Date.now(),
): void {
  db.transaction(() => {
    db.run(`DELETE FROM library_artist_relations WHERE source_mbid = ? AND source = ?`, [
      sourceMbid,
      RELATIONSHIP_SOURCE,
    ]);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO library_artist_relations
         (source_mbid, target_mbid, target_name, kind, score, raw_score, source, fetched_at)
       VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`,
    );
    for (const r of relationships) {
      insert.run(sourceMbid, r.mbid, r.name, r.kind, RELATIONSHIP_SOURCE, now);
    }
    db.run(
      `INSERT INTO library_artist_relation_fetches (mbid, source, fetched_at, results)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(mbid, source) DO UPDATE SET fetched_at = excluded.fetched_at, results = excluded.results`,
      [sourceMbid, RELATIONSHIP_SOURCE, now, relationships.length],
    );
  })();
}

export interface RelationshipNeighbour {
  /** The library artist on the other end. */
  id: string;
  kind: MbRelationshipKind;
}

/** Strongest first: a band and its members before a one-off collaboration. */
const RELATIONSHIP_ORDER: readonly MbRelationshipKind[] = ['member', 'alias', 'collab', 'support'];

/**
 * The library artists `artistId` has a stated relationship with, in either
 * direction: a band stored its members, and a member finds its band through the
 * same row. Owned artists only. Empty when nothing is stored.
 */
export function relationshipNeighbours(db: Database, artistId: string): RelationshipNeighbour[] {
  const { mbidOf, artistOf } = artistMbidIndex(db);
  const mbid = mbidOf.get(artistId);
  if (!mbid) return [];
  const rows = db
    .query<{ other: string; kind: MbRelationshipKind }, [string, string, string, string]>(
      `SELECT target_mbid AS other, kind FROM library_artist_relations
        WHERE source_mbid = ? AND source = ?
       UNION
       SELECT source_mbid AS other, kind FROM library_artist_relations
        WHERE target_mbid = ? AND source = ?`,
    )
    .all(mbid, RELATIONSHIP_SOURCE, mbid, RELATIONSHIP_SOURCE);
  const best = new Map<string, MbRelationshipKind>();
  for (const r of rows) {
    const id = artistOf.get(r.other);
    if (!id || id === artistId) continue;
    const seen = best.get(id);
    if (!seen || RELATIONSHIP_ORDER.indexOf(r.kind) < RELATIONSHIP_ORDER.indexOf(seen)) {
      best.set(id, r.kind);
    }
  }
  return [...best.entries()]
    .map(([id, kind]) => ({ id, kind }))
    .sort(
      (a, b) =>
        RELATIONSHIP_ORDER.indexOf(a.kind) - RELATIONSHIP_ORDER.indexOf(b.kind) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * The seed artist's shared-listener scores as a lookup by library artist id,
 * for radio's cultural axis (#1486). Null when the source was never asked about
 * this artist, so the axis is skipped rather than scored as "unrelated".
 */
export function culturalAffinityFor(
  db: Database,
  seedArtistId: string,
): ((candidateArtistId: string) => number | null) | null {
  const neighbours = culturalNeighbours(db, seedArtistId, 200);
  if (!neighbours) return null;
  const scores = new Map<string, number>();
  for (const n of neighbours) if (n.id) scores.set(n.id, n.score);
  return (id) => scores.get(id) ?? null;
}
