/**
 * Resolve a flag's `(kind, id)` into the card header, or null when the target
 * is not in the library (docs/curator-triage.md "Closed options only").
 *
 * The single worst property of the admin panel the triage round replaced was
 * rendering the bare path-derived sha1 a flag stores as its `targetId`. A
 * curator cannot decide anything about `9d0e6a…`, so every branch returns
 * prose: the entity's own name, plus the one fact that disambiguates a name
 * shared by several entities (an album's artist, a song's artist + album, an
 * artist's catalogue size).
 *
 * An artist flag may carry the RAW NAME rather than an id — `flag_for_review`
 * invites exactly that for an artist the agent could not resolve — so the
 * artist branch tries the id, then the id the scanner would derive from that
 * name, then the name itself. Before this, such a flag rendered as "Missing
 * artist — no longer in the library" while the artist sat in the library.
 *
 * A null is not an error: a flag outlives its target when a song is deleted
 * or re-keyed by a move. The round never serves that card — a human can do
 * nothing about a subject that is gone — and the agent list marks it
 * `targetMissing` so the next pass re-files or resolves it.
 */
import type { Database } from 'bun:sqlite';
import type { CurationCase } from '@nicotind/core';
import type { FlagTargetKind } from '../curation-flags.js';
import { artistIdFor } from '../library-scanner.js';

export type CaseTarget = CurationCase['target'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeTarget(db: Database, kind: FlagTargetKind, id: string): CaseTarget | null {
  if (kind === 'artist') {
    const byId = db.query<{ id: string; name: string; album_count: number }, [string]>(
      'SELECT id, name, album_count FROM library_artists WHERE id = ?',
    );
    const row =
      byId.get(id) ??
      byId.get(artistIdFor(id)) ??
      db
        .query<{ id: string; name: string; album_count: number }, [string]>(
          'SELECT id, name, album_count FROM library_artists WHERE name = ? COLLATE NOCASE',
        )
        .get(id);
    if (!row) return null;
    return {
      kind,
      id: row.id,
      title: row.name,
      subtitle: plural(Number(row.album_count ?? 0), 'album', 'albums'),
    };
  }
  if (kind === 'album') {
    const row = db
      .query<{ name: string; artist: string }, [string]>(
        'SELECT name, artist FROM library_albums WHERE id = ?',
      )
      .get(id);
    return row ? { kind, id, title: row.name, subtitle: row.artist } : null;
  }
  const row = db
    .query<{ title: string; artist: string; album: string | null }, [string]>(
      `SELECT s.title AS title, s.artist AS artist, a.name AS album
         FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
        WHERE s.id = ?`,
    )
    .get(id);
  if (!row) return null;
  return {
    kind,
    id,
    title: row.title,
    subtitle: row.album ? `${row.artist} — ${row.album}` : row.artist,
  };
}
