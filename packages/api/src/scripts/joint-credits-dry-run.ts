/**
 * What the joint-credit rule (#1526) changes, read-only. A full scan runs at boot, so
 * deploying the rule IS the backfill: this is the review step before merging it.
 *
 *   bun run packages/api/src/scripts/joint-credits-dry-run.ts --db <path> [--out report.json]
 *
 * Builds from the DB's scan cache with the real `buildLibrary`, writes nothing and
 * reads no file. See docs/library-scanner.md "List credits".
 */
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { LibraryScanner, type BuiltLibrary } from '../services/library-scanner.js';

export interface StoredLibrary {
  songs: { id: string; artist: string; albumId: string }[];
  songLinks: { songId: string; artistId: string }[];
  artists: {
    id: string;
    name: string;
    albumCount: number;
    hidden: number;
    splitCompound: number;
    fragmentOf: string | null;
    starred: string | null;
    manualOverride: number;
  }[];
}

export interface CreditChange {
  credit: string;
  songs: number;
  before: string[];
  after: string[];
}

export interface DryRunReport {
  songs: { total: number; creditsChanged: number; albumChanged: number; missing: number };
  artists: {
    before: number;
    after: number;
    added: number;
    addedGuests: number;
    removed: number;
    newlyHidden: number;
  };
  grid: { before: number; after: number };
  changes: CreditChange[];
  addedNames: string[];
  removedNames: string[];
  /** Removed rows a person starred or edited: the one loss this report exists to catch. */
  removedCurated: string[];
}

const VARIOUS = 'various artists';

export function compareCredits(built: BuiltLibrary, stored: StoredLibrary): DryRunReport {
  const storedArtist = new Map(stored.artists.map((a) => [a.id, a]));
  const builtArtist = new Map(built.artists.map((a) => [a.id, a]));
  const nameOf = (id: string) => builtArtist.get(id)?.name ?? storedArtist.get(id)?.name ?? id;

  const group = (links: { song: string; artist: string }[]) => {
    const out = new Map<string, string[]>();
    for (const l of links) {
      const list = out.get(l.song) ?? [];
      // The table's primary key collapses a repeat to one link.
      if (!list.includes(l.artist)) out.set(l.song, [...list, l.artist]);
    }
    return out;
  };
  const before = group(stored.songLinks.map((l) => ({ song: l.songId, artist: l.artistId })));
  const after = group(built.songArtists.map((l) => ({ song: l.parentId, artist: l.artistId })));
  const builtSong = new Map(built.songs.map((s) => [s.id, s]));
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();

  const changed = new Map<string, CreditChange>();
  let creditsChanged = 0;
  let albumChanged = 0;
  let missing = 0;
  for (const song of stored.songs) {
    const now = builtSong.get(song.id);
    if (!now) {
      missing++;
      continue;
    }
    if (now.albumId !== song.albumId) albumChanged++;
    const was = before.get(song.id) ?? [];
    const is = after.get(song.id) ?? [];
    if (sameSet(was, is)) continue;
    creditsChanged++;
    const key = `${now.artist}\u0000${[...is].sort().join()}`;
    const entry = changed.get(key);
    if (entry) entry.songs++;
    else {
      changed.set(key, {
        credit: now.artist,
        songs: 1,
        before: was.map(nameOf),
        after: is.map(nameOf),
      });
    }
  }

  const onGrid = (a: {
    name: string;
    albumCount: number;
    hidden: number;
    splitCompound: number | boolean;
    fragmentOf: string | null;
  }) =>
    !a.hidden &&
    !a.splitCompound &&
    a.fragmentOf === null &&
    a.albumCount > 0 &&
    a.name.toLowerCase() !== VARIOUS;

  const added = built.artists.filter((a) => !storedArtist.has(a.id));
  const removed = stored.artists.filter((a) => !builtArtist.has(a.id));
  return {
    songs: { total: stored.songs.length, creditsChanged, albumChanged, missing },
    artists: {
      before: stored.artists.length,
      after: built.artists.length,
      added: added.length,
      addedGuests: added.filter((a) => a.albumCount === 0).length,
      removed: removed.length,
      newlyHidden: built.artists.filter(
        (a) => a.splitCompound && storedArtist.get(a.id)?.splitCompound === 0,
      ).length,
    },
    grid: {
      before: stored.artists.filter(onGrid).length,
      after: built.artists.filter((a) => {
        const was = storedArtist.get(a.id);
        return onGrid({
          name: a.name,
          albumCount: a.albumCount,
          hidden: was?.hidden ?? 0,
          splitCompound: a.splitCompound,
          fragmentOf: was?.fragmentOf ?? null,
        });
      }).length,
    },
    changes: [...changed.values()].sort(
      (a, b) => b.songs - a.songs || a.credit.localeCompare(b.credit, 'en'),
    ),
    addedNames: added.map((a) => a.name).sort((a, b) => a.localeCompare(b, 'en')),
    removedNames: removed.map((a) => a.name).sort((a, b) => a.localeCompare(b, 'en')),
    removedCurated: removed
      .filter((a) => a.starred !== null || a.manualOverride !== 0)
      .map((a) => a.name),
  };
}

function loadStored(db: Database): StoredLibrary {
  return {
    songs: db
      .query<StoredLibrary['songs'][number], []>(
        'SELECT id, artist, album_id AS albumId FROM library_songs',
      )
      .all(),
    songLinks: db
      .query<StoredLibrary['songLinks'][number], []>(
        'SELECT song_id AS songId, artist_id AS artistId FROM library_song_artists ORDER BY position',
      )
      .all(),
    artists: db
      .query<StoredLibrary['artists'][number], []>(
        `SELECT id, name, album_count AS albumCount, hidden, split_compound AS splitCompound,
                fragment_of AS fragmentOf, starred, manual_override AS manualOverride
           FROM library_artists`,
      )
      .all(),
  };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const path = arg('--db');
  if (!path) throw new Error('--db <path> is required');
  const db = new Database(path, { readonly: true });
  const report = compareCredits(new LibraryScanner('', db).previewFullBuild(), loadStored(db));
  const out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        songs: report.songs,
        artists: report.artists,
        grid: report.grid,
        removedCurated: report.removedCurated,
        changedCredits: report.changes.length,
      },
      null,
      2,
    ),
  );
}
