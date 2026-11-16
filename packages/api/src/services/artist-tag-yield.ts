/**
 * How many artist tags in the library the organizer's sanitizer would alter
 * (#864). The scan path mints artist and album ids from the raw tag; wiring the
 * sanitizer in would re-mint an id for every row counted here. This is that
 * count, read-only, so the size of the change is known before it is made.
 */
import type { Database } from 'bun:sqlite';
import { normalizeTagValue } from './audio-tags.js';
import { sanitizeArtistTag } from './tag-sanitize.js';

export interface ArtistTagChange {
  column: 'artist' | 'album_artist';
  raw: string;
  /** What the sanitizer makes of it; null when it would drop the value. */
  clean: string | null;
  songs: number;
}

export interface ArtistTagYield {
  /** Distinct (column, value) pairs examined. */
  examined: number;
  wouldChange: { values: number; songs: number };
  wouldDrop: { values: number; songs: number };
  /** Worst first, by songs. */
  sample: ArtistTagChange[];
}

export function artistTagYield(db: Database, sample: number): ArtistTagYield {
  const rows = [
    ...db
      .query<{ raw: string; songs: number }, []>(
        `SELECT artist AS raw, COUNT(*) AS songs FROM library_songs
          WHERE artist IS NOT NULL AND artist != '' GROUP BY artist`,
      )
      .all()
      .map((r) => ({ ...r, column: 'artist' as const })),
    ...db
      .query<{ raw: string; songs: number }, []>(
        `SELECT album_artist AS raw, COUNT(*) AS songs FROM library_songs
          WHERE album_artist IS NOT NULL AND album_artist != '' GROUP BY album_artist`,
      )
      .all()
      .map((r) => ({ ...r, column: 'album_artist' as const })),
  ];
  const out: ArtistTagYield = {
    examined: rows.length,
    wouldChange: { values: 0, songs: 0 },
    wouldDrop: { values: 0, songs: 0 },
    sample: [],
  };
  const changes: ArtistTagChange[] = [];
  for (const r of rows) {
    const clean = sanitizeArtistTag(normalizeTagValue(r.raw)) ?? null;
    if (clean === r.raw) continue;
    const bucket = clean === null ? out.wouldDrop : out.wouldChange;
    bucket.values++;
    bucket.songs += r.songs;
    changes.push({ column: r.column, raw: r.raw, clean, songs: r.songs });
  }
  out.sample = changes
    .sort((a, b) => b.songs - a.songs || a.raw.localeCompare(b.raw))
    .slice(0, sample);
  return out;
}
