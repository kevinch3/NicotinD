import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { LyricsDto } from '@nicotind/core';
import { readAudioTags, writeAudioTags } from './audio-tags.js';
import { getLyrics, setLyrics } from './lyrics-store.js';
import type { PluginRegistry } from './plugins/registry.js';
import { expandDir, isUnderMusicDir, resolveSongPath } from './song-path.js';

export type LyricsFetchOutcome =
  | { kind: 'fetched'; lyrics: LyricsDto }
  | { kind: 'cached'; lyrics: LyricsDto }
  | { kind: 'no-match' }
  | { kind: 'song-not-found' }
  | { kind: 'no-source' }
  | { kind: 'source-error' };

/**
 * Fetch a song's lyrics from the enabled sources, shared by
 * `POST /songs/:id/lyrics/fetch` and the MCP `refetch_song_lyrics` tool.
 *
 * Without `force`, a stored row is returned as-is and, when there is none, the
 * plain text embedded in the file tag is recovered before any source is asked
 * (a path change re-mints the song id and orphans the row; the tag travels
 * with the file). **With `force`, the tag is skipped too** (#1205): a fetch
 * writes its plain text into the tag, so after a bad match the tag holds the
 * same wrong words, and recovering from it made delete-then-refetch return
 * them again without contacting the source.
 *
 * A forced fetch that finds nothing leaves any stored row in place.
 */
export async function fetchSongLyrics(
  db: Database,
  deps: { plugins?: PluginRegistry | null; musicDir?: string },
  songId: string,
  opts: { force?: boolean } = {},
): Promise<LyricsFetchOutcome> {
  const song = db
    .query<
      { path: string; title: string; artist: string; duration: number; album: string | null },
      [string]
    >(
      `SELECT s.path, s.title, s.artist, s.duration, a.name AS album
       FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
       WHERE s.id = ?`,
    )
    .get(songId);
  if (!song) return { kind: 'song-not-found' };

  const existing = getLyrics(db, songId);
  if (existing && !opts.force) return { kind: 'cached', lyrics: existing };

  const md = deps.musicDir ? expandDir(deps.musicDir) : null;
  const abs = md ? resolveSongPath(md, song.path) : null;
  const onDisk = md !== null && abs !== null && isUnderMusicDir(md, abs) && existsSync(abs);

  if (!existing && !opts.force && onDisk) {
    const tags = await readAudioTags(abs!).catch(() => null);
    if (tags?.lyrics) {
      return {
        kind: 'fetched',
        lyrics: setLyrics(db, songId, {
          plain: tags.lyrics,
          synced: null,
          source: 'file-tag',
          customized: false,
        }),
      };
    }
  }

  if (!deps.plugins?.hasCapability('lyrics')) return { kind: 'no-source' };

  const query = {
    title: song.title,
    artist: song.artist,
    album: song.album ?? undefined,
    durationSec: song.duration || undefined,
  };
  // A source that threw is not a source that cleanly missed: the caller offers
  // a retry for the first and "no lyrics" for the second.
  let sourceErrored = false;
  for (const plugin of deps.plugins.getEnabledWithCapability('lyrics')) {
    const result = await plugin.lyrics?.fetchLyrics(query).catch(() => {
      sourceErrored = true;
      return null;
    });
    if (!result) continue;
    const saved = setLyrics(db, songId, {
      plain: result.plain,
      synced: result.synced,
      source: result.source,
      customized: false,
      // Recorded so a wrong-take match stays visible after the fact; a source
      // that reports no duration leaves these null, i.e. unverified (#1212).
      matchedDurationSec: result.matchedDurationSec ?? null,
      sourceTrackId: result.sourceTrackId ?? null,
    });
    if (result.plain && onDisk) {
      await writeAudioTags(abs!, { lyrics: result.plain }).catch(() => false);
    }
    return { kind: 'fetched', lyrics: saved };
  }
  return sourceErrored ? { kind: 'source-error' } : { kind: 'no-match' };
}
