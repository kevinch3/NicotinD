import type { Database } from 'bun:sqlite';
import type { SongRow } from './library-scanner.js';

/**
 * What a scan would write for each `library_songs` column, in the order of the
 * scanner's upsert. `keep` marks the columns its ON CONFLICT clause COALESCEs,
 * where a null from the tags keeps the stored value instead of clearing it.
 */
export const SONG_COLUMNS: ReadonlyArray<{
  col: string;
  get: (s: SongRow) => unknown;
  keep?: true;
}> = [
  { col: 'album_id', get: (s) => s.albumId },
  { col: 'title', get: (s) => s.title },
  { col: 'artist', get: (s) => s.artist },
  { col: 'artist_id', get: (s) => s.artistId },
  { col: 'album_artist', get: (s) => s.albumArtist },
  { col: 'album_artist_id', get: (s) => s.albumArtistId },
  { col: 'track', get: (s) => s.track },
  { col: 'disc', get: (s) => s.disc },
  { col: 'duration', get: (s) => s.duration },
  { col: 'year', get: (s) => s.year },
  { col: 'genre', get: (s) => s.genre, keep: true },
  { col: 'bpm', get: (s) => s.bpm, keep: true },
  { col: 'key', get: (s) => s.key, keep: true },
  { col: 'energy', get: (s) => s.energy, keep: true },
  { col: 'loudness', get: (s) => s.loudness, keep: true },
  { col: 'danceability', get: (s) => s.danceability, keep: true },
  { col: 'valence', get: (s) => s.valence, keep: true },
  { col: 'acousticness', get: (s) => s.acousticness, keep: true },
  { col: 'instrumental', get: (s) => s.instrumental, keep: true },
  { col: 'mood', get: (s) => s.mood, keep: true },
  { col: 'cover_art', get: (s) => s.coverArt },
  { col: 'path', get: (s) => s.path },
  { col: 'size', get: (s) => s.size },
  { col: 'bit_rate', get: (s) => s.bitRate },
  { col: 'sample_rate', get: (s) => s.sampleRate },
  { col: 'bit_depth', get: (s) => s.bitDepth },
  { col: 'channels', get: (s) => s.channels },
  { col: 'suffix', get: (s) => s.suffix },
  { col: 'content_type', get: (s) => s.contentType },
  { col: 'has_embedded_art', get: (s) => s.hasEmbeddedArt, keep: true },
  { col: 'created', get: (s) => s.created },
];

type StoredSong = Record<string, unknown>;

/**
 * True when upserting `s` over `stored` would leave every column as it is, so
 * the write can be skipped (#1309). Mirrors the upsert's COALESCE columns.
 */
export function songUnchanged(stored: StoredSong, s: SongRow): boolean {
  for (const { col, get, keep } of SONG_COLUMNS) {
    const next = get(s) ?? null;
    const prev = stored[col] ?? null;
    const effective = keep && next === null ? prev : next;
    if (effective !== prev) return false;
  }
  return true;
}

/**
 * Stored rows keyed by id, with every column `songUnchanged` compares — for
 * `ids`, or the whole table when `ids` is null (a full scan needs every row,
 * and one pass beats fifty chunked `IN` lookups).
 */
export function loadStoredSongs(db: Database, ids: string[] | null): Map<string, StoredSong> {
  const cols = SONG_COLUMNS.map((c) => c.col).join(', ');
  const out = new Map<string, StoredSong>();
  if (ids === null) {
    for (const r of db
      .query<StoredSong & { id: string }, []>(`SELECT id, ${cols} FROM library_songs`)
      .all())
      out.set(r.id, r);
    return out;
  }
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .query<StoredSong & { id: string }, string[]>(
        `SELECT id, ${cols} FROM library_songs WHERE id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk);
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

/**
 * Each song's current link set in `table` as one comparable string per song —
 * `(target, role?, position)` tuples, sorted. Songs with no rows are absent.
 */
export function loadLinkKeys(
  db: Database,
  table: 'library_song_artists' | 'library_song_genres',
  ids: string[] | null,
): Map<string, string> {
  const select =
    table === 'library_song_artists'
      ? 'SELECT song_id, artist_id AS target, role, position FROM library_song_artists'
      : "SELECT song_id, genre AS target, '' AS role, position FROM library_song_genres";
  const tuples = new Map<string, string[]>();
  type LinkRow = { song_id: string; target: string; role: string; position: number };
  const add = (rows: LinkRow[]) => {
    for (const r of rows) {
      const list = tuples.get(r.song_id) ?? [];
      list.push(linkTuple(r.target, r.role, r.position));
      tuples.set(r.song_id, list);
    }
  };
  if (ids === null) add(db.query<LinkRow, []>(select).all());
  for (let i = 0; ids !== null && i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    add(
      db
        .query<LinkRow, string[]>(`${select} WHERE song_id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk),
    );
  }
  return new Map([...tuples].map(([id, list]) => [id, list.sort().join('\n')]));
}

/**
 * The same per-song key `loadLinkKeys` produces, for links a scan is about to
 * write. `pkOf` is the row's primary key within the song: a repeat of it is one
 * row in the table (the upsert's last position wins), so it is one tuple here.
 */
export function linkKeysOf<T>(
  links: T[],
  songOf: (l: T) => string,
  pkOf: (l: T) => string,
  tupleOf: (l: T) => string,
): Map<string, string> {
  const rows = new Map<string, Map<string, string>>();
  for (const l of links) {
    const bySong = rows.get(songOf(l)) ?? new Map<string, string>();
    bySong.set(pkOf(l), tupleOf(l));
    rows.set(songOf(l), bySong);
  }
  return new Map([...rows].map(([id, m]) => [id, [...m.values()].sort().join('\n')]));
}

export function linkTuple(target: string, role: string, position: number): string {
  return `${target}\u0000${role}\u0000${position}`;
}
