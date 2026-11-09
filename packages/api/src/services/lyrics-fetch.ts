import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { LyricsChoice, LyricsDto, LyricsResult } from '@nicotind/core';
import { LYRICS_DURATION_TOLERANCE_SEC, lrcOverrunSec } from '@nicotind/core';
import { readAudioTags, writeAudioTags } from './audio-tags.js';
import { getLyrics, setLyrics } from './lyrics-store.js';
import type { PluginRegistry } from './plugins/registry.js';
import { expandDir, isUnderMusicDir, resolveSongPath } from './song-path.js';

export type LyricsFetchOutcome =
  | { kind: 'fetched'; lyrics: LyricsDto }
  | { kind: 'cached'; lyrics: LyricsDto }
  /** A forced fetch found only untimed lyrics for a song stored timed; the row is unchanged. */
  | { kind: 'kept-timed'; lyrics: LyricsDto }
  /** A forced fetch on a row a user edited, without `confirmReplaceEdit`; the row is unchanged. */
  | { kind: 'customized'; lyrics: LyricsDto }
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
 * A forced fetch that finds nothing leaves any stored row in place, and **a
 * fetch never replaces timed lyrics with untimed ones** (#1672): LRCLIB can
 * answer the same song with or without timings from one call to the next, and
 * a plain-only answer used to overwrite the stored LRC — and the user's sync
 * offset — with NULL. A plain-only candidate is skipped in favour of the next
 * source; when none has timings the stored row is returned as `kept-timed`.
 * A timed answer whose LRC is the stored text again keeps the sync offset, which
 * was measured against that text (#1785); different timed text resets it.
 * The one exception is a stored timed row matched to **another take** — its
 * recorded duration beyond `LYRICS_DURATION_TOLERANCE_SEC` of the song's, or its
 * LRC running past the end of the file (`lrcOverrunSec`, the health report's
 * detector for rows with no recorded duration): those are wrong words, and
 * replacing them is what a re-fetch is for (#1205).
 *
 * **A forced fetch never replaces a user's edit unasked** (#1786): a `customized`
 * row answers `customized` unless the caller passes `confirmReplaceEdit`, which
 * the web app sends only after the listener confirms.
 */
export async function fetchSongLyrics(
  db: Database,
  deps: { plugins?: PluginRegistry | null; musicDir?: string },
  songId: string,
  opts: { force?: boolean; confirmReplaceEdit?: boolean } = {},
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
  if (existing?.customized && !opts.confirmReplaceEdit) {
    return { kind: 'customized', lyrics: existing };
  }

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
          choice: {
            source: 'file-tag',
            sourceTrackId: null,
            timed: false,
            matchedDurationSec: null,
            localDurationSec: song.duration > 0 ? song.duration : null,
            durationDeltaSec: null,
            matchedBy: null,
            skippedUntimed: [],
            replacedOtherTake: false,
            forced: false,
            at: Date.now(),
          },
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
  let keptTimed = false;
  const skippedUntimed: string[] = [];
  // Either detector the health report uses: a recorded match duration beyond the
  // tolerance, or (for rows whose source never stated one) an LRC that outlasts
  // the file.
  const storedIsOtherTake =
    !!existing?.synced &&
    song.duration > 0 &&
    ((existing.matchedDurationSec != null &&
      Math.abs(existing.matchedDurationSec - song.duration) > LYRICS_DURATION_TOLERANCE_SEC) ||
      lrcOverrunSec(existing.synced, existing.offsetMs, song.duration) >
        LYRICS_DURATION_TOLERANCE_SEC);
  for (const plugin of deps.plugins.getEnabledWithCapability('lyrics')) {
    const result = await plugin.lyrics?.fetchLyrics(query).catch(() => {
      sourceErrored = true;
      return null;
    });
    if (!result) continue;
    if (existing?.synced && !result.synced && !storedIsOtherTake) {
      keptTimed = true;
      skippedUntimed.push(result.source);
      continue;
    }
    const saved = setLyrics(db, songId, {
      plain: result.plain,
      synced: result.synced,
      source: result.source,
      customized: false,
      // Recorded so a wrong-take match stays visible after the fact; a source
      // that reports no duration leaves these null, i.e. unverified (#1212).
      matchedDurationSec: result.matchedDurationSec ?? null,
      sourceTrackId: result.sourceTrackId ?? null,
      // The same timed text again: the offset was measured against it (#1785).
      ...(existing?.synced && result.synced && sameLrc(existing.synced, result.synced)
        ? { offsetMs: existing.offsetMs }
        : {}),
      choice: choiceFor(result, song.duration, {
        skippedUntimed,
        replacedOtherTake: storedIsOtherTake,
        forced: !!opts.force,
      }),
    });
    if (result.plain && onDisk) {
      await writeAudioTags(abs!, { lyrics: result.plain }).catch(() => false);
    }
    return { kind: 'fetched', lyrics: saved };
  }
  if (keptTimed && existing) return { kind: 'kept-timed', lyrics: existing };
  return sourceErrored ? { kind: 'source-error' } : { kind: 'no-match' };
}

/** Two LRC bodies are the same text, ignoring line endings and edge whitespace. */
function sameLrc(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\r\n?/g, '\n').trim();
  return norm(a) === norm(b);
}

/**
 * Why `result` was the one stored (#1676), recorded beside the words so a song
 * whose lyrics changed under a listener can be explained from the row alone.
 */
function choiceFor(
  result: LyricsResult,
  localDuration: number,
  ctx: Pick<LyricsChoice, 'skippedUntimed' | 'replacedOtherTake' | 'forced'>,
): LyricsChoice {
  const matched = result.matchedDurationSec ?? null;
  const local = localDuration > 0 ? localDuration : null;
  return {
    source: result.source,
    sourceTrackId: result.sourceTrackId ?? null,
    timed: !!result.synced,
    matchedDurationSec: matched,
    localDurationSec: local,
    durationDeltaSec: matched != null && local != null ? matched - local : null,
    matchedBy: result.matchedBy ?? null,
    skippedUntimed: [...ctx.skippedUntimed],
    replacedOtherTake: ctx.replacedOtherTake,
    forced: ctx.forced,
    at: Date.now(),
  };
}
