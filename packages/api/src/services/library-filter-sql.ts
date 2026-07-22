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
 * Licence conditions on a column `col`: positive codes → `col IN (…)`, the
 * `unknown` bucket → `col IS NULL` (un-licenced), ORed into a single where.
 * Shared by the per-song filter (`s.licence`) and the album-level aggregate
 * filter (`library_albums.licence`), so both read identically.
 */
function licenceWheres(licences: string[], col: string): FilterSqlFragment {
  const positive = licences.filter((l) => l !== 'unknown');
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (positive.length) {
    parts.push(`${col} IN (${placeholders(positive.length)})`);
    params.push(...positive);
  }
  if (licences.includes('unknown')) parts.push(`${col} IS NULL`);
  if (parts.length === 0) return { wheres: [], params: [] };
  return { wheres: [parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`], params };
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
    const lic = licenceWheres(f.licences, `${alias}.licence`);
    wheres.push(...lic.wheres);
    params.push(...lic.params);
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

/**
 * Any-track EXISTS over an entity, plus entity-level starred. When
 * `licenceColumn` is given (albums), the licence filter is applied to that
 * *stored aggregate* column directly — "the album is entirely this licence" —
 * and removed from the any-track EXISTS. Without it (artists, which have no
 * licence column) licence stays in the EXISTS as an any-track match.
 */
function entityFilterWheres(
  f: LibraryFilter,
  entityRef: string,
  correlation: string,
  opts: { licenceColumn?: string } = {},
): FilterSqlFragment {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (f.starred) wheres.push(`${entityRef}.starred IS NOT NULL`);

  let inner: LibraryFilter = { ...f, starred: undefined };
  if (opts.licenceColumn && f.licences?.length) {
    const lic = licenceWheres(f.licences, opts.licenceColumn);
    wheres.push(...lic.wheres);
    params.push(...lic.params);
    inner = { ...inner, licences: undefined };
  }

  const song = songFilterWheres(inner, 'ls');
  if (song.wheres.length === 0) return { wheres, params };
  wheres.push(
    `EXISTS (SELECT 1 FROM library_songs ls WHERE ${correlation} AND ls.hidden = 0 AND ${song.wheres.join(' AND ')})`,
  );
  params.push(...song.params);
  return { wheres, params };
}

/** Fragment for the album list routes (/albums, /singles, /compilations). */
export function albumFilterWheres(f: LibraryFilter): FilterSqlFragment {
  return entityFilterWheres(f, 'library_albums', 'ls.album_id = library_albums.id', {
    licenceColumn: 'library_albums.licence',
  });
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
