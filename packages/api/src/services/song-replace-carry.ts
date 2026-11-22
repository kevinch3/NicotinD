import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { pruneOrphanAlbum } from './library-aggregates.js';
import { libraryEvents } from './library-events.js';
import { songId } from './library-scanner.js';
import { carrySongCuration } from './song-curation-carry.js';

const log = createLogger('song-replace-carry');

/**
 * Which of the organizer's collapsed duplicates were library files that an
 * incoming file replaced.
 *
 * The organizer keeps one best copy per track in an album folder and reports
 * every deleted path with the path that survived it. Two cases come back in
 * that one map: an incoming file that lost to the copy the library held (the
 * poller re-points the item at the survivor), and a library file that lost to
 * an incoming one. Only the second replaces a song, so only it has state to
 * carry.
 */
export function replacedLibraryFiles(
  superseded: Readonly<Record<string, string>>,
  incoming: ReadonlySet<string>,
): Array<{ fromPath: string; toPath: string }> {
  const out: Array<{ fromPath: string; toPath: string }> = [];
  for (const [loser, winner] of Object.entries(superseded)) {
    if (!incoming.has(loser) && incoming.has(winner)) out.push({ fromPath: loser, toPath: winner });
  }
  return out;
}

/** A replaced song, read before the scan that prunes its row. */
export interface ReplacedSong {
  fromId: string;
  toId: string;
  fromPath: string;
  toPath: string;
  /** The old row's own columns, or null when the row was already gone. */
  held: { starred: string | null; hidden: number } | null;
}

/**
 * Read what a replaced song keeps on its own row, while the row still exists.
 *
 * Must run before the batch's scan: the album reconcile prunes a row whose file
 * is gone (`pruneAlbumOrphans`), and `starred`/`hidden` go with it. Everything
 * else a song owns lives in its own table, keyed by the id, and survives the
 * prune for `carryReplacedSongs` to move, so a pair is kept even when its row
 * is already gone: a full scan that overlapped the organize (the library
 * watcher starts one seconds after a transcode removes its source) prunes it
 * first, and only the two columns are lost then.
 */
export function snapshotReplacedSongs(
  db: Database,
  replaced: ReadonlyArray<{ fromPath: string; toPath: string }>,
): ReplacedSong[] {
  return replaced.map(({ fromPath, toPath }) => {
    const fromId = songId(fromPath);
    const held = db
      .query<{ starred: string | null; hidden: number }, [string]>(
        'SELECT starred, hidden FROM library_songs WHERE id = ?',
      )
      .get(fromId);
    return { fromId, toId: songId(toPath), fromPath, toPath, held: held ?? null };
  });
}

/**
 * Every lane that runs the shared `organizeBatch` calls this before its scan,
 * with the batch's `supersededRelPaths` and the paths the batch placed, and
 * `carryReplacedSongs` after it. Three lanes do (the addon poller, the import
 * service, the URL watcher); a fourth that skipped it would lose a replaced
 * song's history again (#2061).
 */
export function snapshotBatchReplacements(
  db: Database,
  superseded: Readonly<Record<string, string>> | undefined,
  placed: Iterable<string>,
): ReplacedSong[] {
  return snapshotReplacedSongs(db, replacedLibraryFiles(superseded ?? {}, new Set(placed)));
}

/**
 * Carry a replaced song's state onto the copy that took its place (#2032).
 *
 * Song ids are `sha1(path)`, so a better copy that wins the folder reconcile
 * is a new song to every song-keyed table. Without this, only what the scan
 * re-matched by title, artist and duration survived (genre overrides); likes,
 * playlist membership, plays, lyrics and album overrides stayed keyed to an id
 * nothing has.
 *
 * Runs after the scan that indexed the new file, like the transcode's carry. A
 * new file the scan did not index has nowhere to carry to, so its pair is left
 * alone. The old row is normally gone by now; it is still there when the new
 * copy was filed under another album row, and is dropped here so the song is
 * not listed twice. `starred`/`hidden` are restored only when the snapshot
 * caught the old row. Returns how many songs were carried.
 */
export function carryReplacedSongs(db: Database, replaced: ReadonlyArray<ReplacedSong>): number {
  let carried = 0;
  for (const song of replaced) {
    if (!db.query('SELECT 1 FROM library_songs WHERE id = ?').get(song.toId)) continue;
    try {
      // Assigned inside the transaction callback, so not narrowed to null here.
      let staleAlbumId = null as string | null;
      db.transaction(() => {
        const stale = db
          .query<{ album_id: string }, [string]>('SELECT album_id FROM library_songs WHERE id = ?')
          .get(song.fromId);
        if (stale) {
          staleAlbumId = stale.album_id;
          db.run('DELETE FROM library_songs WHERE id = ?', [song.fromId]);
          db.run('DELETE FROM library_song_artists WHERE song_id = ?', [song.fromId]);
          db.run('DELETE FROM library_song_genres WHERE song_id = ?', [song.fromId]);
          pruneOrphanAlbum(db, stale.album_id);
        }
        if (song.held) {
          db.run('UPDATE library_songs SET starred = ?, hidden = ? WHERE id = ?', [
            song.held.starred,
            song.held.hidden,
            song.toId,
          ]);
        }
        carrySongCuration(db, {
          fromId: song.fromId,
          toId: song.toId,
          fromPath: song.fromPath,
          toPath: song.toPath,
        });
      })();
      if (staleAlbumId) {
        libraryEvents.emit({
          type: 'songs.deleted',
          songIds: [song.fromId],
          albumIds: [staleAlbumId],
        });
      }
      carried += 1;
      log.info(
        { fromPath: song.fromPath, toPath: song.toPath },
        'carried a replaced song onto the copy that replaced it',
      );
    } catch (err) {
      // The file swap already happened; a failed carry must not fail the ingest.
      log.warn(
        { err, fromPath: song.fromPath, toPath: song.toPath },
        'carry for a replaced song failed; continuing',
      );
    }
  }
  return carried;
}
