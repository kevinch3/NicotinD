/**
 * LibraryFilter → parameterized SQL fragments for the library list routes.
 * Pure string/param builders (peer of song-sort.ts): callers splice the
 * returned wheres/params into their existing wheres[]/params[] arrays.
 *
 * Semantics: song-level properties use any-track matching on album/artist
 * lists (one EXISTS whose body ANDs every song condition — a single track
 * must satisfy the whole conjunction). Starred is the one entity-level
 * property: it filters the album/artist/song row itself, never the EXISTS.
 * Bucket thresholds are code constants (BUCKET_THRESHOLDS), inlined as
 * literals; user values only ever travel as `?` params.
 */
import {
  BUCKET_THRESHOLDS,
  PERCEPTUAL_AXES,
  camelotToKeys,
  type LibraryFilter,
  type PerceptualBucket,
} from '@nicotind/core';

export interface FilterSqlFragment {
  wheres: string[];
  params: Array<string | number>;
}

const { low: LOW, high: HIGH } = BUCKET_THRESHOLDS;

function bucketCondition(col: string, buckets: PerceptualBucket[]): string {
  const set = new Set(buckets);
  if (set.size === 3) return `${col} IS NOT NULL`;
  const parts: string[] = [];
  if (set.has('low')) parts.push(`${col} <= ${LOW}`);
  if (set.has('mid')) parts.push(`(${col} > ${LOW} AND ${col} < ${HIGH})`);
  if (set.has('high')) parts.push(`${col} >= ${HIGH}`);
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Song-level conditions against `alias` (a library_songs row). Includes
 * song-level starred — the entity-EXISTS builders below strip it out.
 */
export function songFilterWheres(f: LibraryFilter, alias = 's'): FilterSqlFragment {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (f.starred) wheres.push(`${alias}.starred IS NOT NULL`);
  if (f.bpmMin !== undefined) {
    wheres.push(`${alias}.bpm >= ?`);
    params.push(f.bpmMin);
  }
  if (f.bpmMax !== undefined) {
    wheres.push(`${alias}.bpm <= ?`);
    params.push(f.bpmMax);
  }
  if (f.keys?.length) {
    const keyNames = f.keys.flatMap(camelotToKeys);
    if (keyNames.length) {
      wheres.push(`${alias}.key IN (${placeholders(keyNames.length)})`);
      params.push(...keyNames);
    }
  }
  if (f.moods?.length) {
    wheres.push(`${alias}.mood IN (${placeholders(f.moods.length)})`);
    params.push(...f.moods);
  }
  for (const axis of PERCEPTUAL_AXES) {
    const buckets = f.buckets?.[axis];
    if (buckets?.length) wheres.push(bucketCondition(`${alias}.${axis}`, buckets));
  }
  if (f.yearMin !== undefined) {
    wheres.push(`${alias}.year >= ?`);
    params.push(f.yearMin);
  }
  if (f.yearMax !== undefined) {
    wheres.push(`${alias}.year <= ?`);
    params.push(f.yearMax);
  }
  if (f.genres?.length) {
    // Match the FULL genre set via the join table so a track filed under
    // "Electronic; House" matches a House filter; the primary-column IN keeps
    // pre-first-rescan rows (join table not yet populated) filterable.
    const marks = placeholders(f.genres.length);
    wheres.push(
      `(${alias}.genre IN (${marks}) OR EXISTS (SELECT 1 FROM library_song_genres sg WHERE sg.song_id = ${alias}.id AND sg.genre IN (${marks})))`,
    );
    params.push(...f.genres, ...f.genres);
  }
  if (f.licences?.length) {
    // 'unknown' is a UI bucket that maps to SQL NULL (un-licenced rows); the
    // positive codes match the stored value directly. Both OR together.
    const positive = f.licences.filter((l) => l !== 'unknown');
    const parts: string[] = [];
    if (positive.length) {
      parts.push(`${alias}.licence IN (${placeholders(positive.length)})`);
      params.push(...positive);
    }
    if (f.licences.includes('unknown')) parts.push(`${alias}.licence IS NULL`);
    if (parts.length) wheres.push(parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`);
  }
  if (f.durationMin !== undefined) {
    wheres.push(`${alias}.duration >= ?`);
    params.push(f.durationMin);
  }
  if (f.durationMax !== undefined) {
    wheres.push(`${alias}.duration <= ?`);
    params.push(f.durationMax);
  }
  return { wheres, params };
}

/** Any-track EXISTS over an entity, plus entity-level starred. */
function entityFilterWheres(
  f: LibraryFilter,
  entityRef: string,
  correlation: string,
): FilterSqlFragment {
  const wheres: string[] = [];
  if (f.starred) wheres.push(`${entityRef}.starred IS NOT NULL`);
  const song = songFilterWheres({ ...f, starred: undefined }, 'ls');
  if (song.wheres.length === 0) return { wheres, params: [] };
  wheres.push(
    `EXISTS (SELECT 1 FROM library_songs ls WHERE ${correlation} AND ls.hidden = 0 AND ${song.wheres.join(' AND ')})`,
  );
  return { wheres, params: song.params };
}

/** Fragment for the album list routes (/albums, /singles, /compilations). */
export function albumFilterWheres(f: LibraryFilter): FilterSqlFragment {
  return entityFilterWheres(f, 'library_albums', 'ls.album_id = library_albums.id');
}

/** Fragment for /artists, honoring multi-artist credits via the join table. */
export function artistFilterWheres(f: LibraryFilter): FilterSqlFragment {
  return entityFilterWheres(
    f,
    'library_artists',
    '(ls.artist_id = library_artists.id OR ls.id IN ' +
      '(SELECT song_id FROM library_song_artists WHERE artist_id = library_artists.id))',
  );
}
