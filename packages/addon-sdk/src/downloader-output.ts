/**
 * Parsers for the stdout an acquisition addon's downloader writes.
 *
 * These live in the SDK, not in core, because the only processes that can see
 * that stdout are the addons themselves — since the phase-4 split, core never
 * spawns yt-dlp or spotDL. They were written for the retired in-process
 * plugins, and moving them here is what lets the external addons keep the
 * behaviour that left with those plugins rather than each re-deriving the
 * regexes (or, as both currently do, discarding the stream entirely).
 *
 * What the stream carries that nothing else does:
 *
 * - **The playlist's name.** Neither downloader exposes it any other way, so an
 *   addon that ignores stdout can only ever report "<Source> download". Feed it
 *   to `AddonJob.title` (protocol 1.1) and the host renders the real name.
 * - **The expected track count.** Without it a partial download is
 *   indistinguishable from a complete one: the addon globs whatever landed and
 *   reports it as the whole job, so 1 track of 16 reads as a clean "Done 1 of
 *   1". The host cannot detect this — only the source knows how many there were.
 * - **Per-track events, in order.** The order files appear on disk is the
 *   downloader's output-template order (artist/album), not the playlist's.
 *
 * Every function here is pure and line-at-a-time, so an addon can pipe stdout
 * through `readline` and fold over them without buffering.
 */

export interface AcquireProgress {
  done: number;
  total: number;
}

/** Per-track download status, as reported by a track-event parser. */
export type DownloaderTrackStatus = 'downloading' | 'done' | 'skipped' | 'failed';

/**
 * Named `Downloader…` rather than the obvious `TrackEvent` on purpose: that is
 * a **DOM global**, so a bare `TrackEvent` silently resolves to the browser
 * type in any file that doesn't import it into local scope — which is exactly
 * how this seam's type quietly became `HTMLTrackElement`'s event.
 */
export interface DownloaderTrackEvent {
  title: string;
  status: DownloaderTrackStatus;
  /**
   * The file basename the downloader is about to write / just wrote. Optional —
   * older markers don't carry it, and a consumer falls back to matching on
   * title alone when it is missing.
   */
  path?: string;
  /** For `failed`: the downloader's own reason (`LookupError: No results …`). */
  detail?: string;
}

/**
 * spotDL 4.5.x announces a list as `Found %s songs in %s (%s)` — the name, then
 * the list's class (`Playlist`/`Album`/`Artist`/`Saved`) in parentheses.
 * Earlier versions wrote `Found N songs in playlist: <name>`. Both shapes are
 * read; the current one is anchored on the trailing `(Kind)` so a name that
 * itself ends in parentheses (`Ídolo (Deluxe)`) survives.
 */
const SPOTDL_FOUND_CURRENT =
  /\bFound (\d+) songs? in (.+) \((Playlist|Album|Artist|Saved|Song)\)\s*$/i;
const SPOTDL_FOUND_LEGACY = /\bFound (\d+) songs? in playlist:\s*(.+)/i;

/** Parse yt-dlp's `--newline` progress output: `[download]  45.2% of ...` */
export function parseYtdlpProgress(line: string, current: AcquireProgress): AcquireProgress {
  const match = /\[download\]\s+([\d.]+)%/.exec(line);
  if (match) {
    const pct = parseFloat(match[1]!);
    if (!Number.isNaN(pct)) return { done: Math.round(pct), total: 100 };
  }
  // Playlist item counter: `[download] Downloading item 3 of 12`
  const itemMatch = /Downloading item (\d+) of (\d+)/.exec(line);
  if (itemMatch) {
    return { done: parseInt(itemMatch[1]!, 10), total: parseInt(itemMatch[2]!, 10) };
  }
  return current;
}

/**
 * Parse spotDL plain-log output (non-TTY mode) into a song-count progress.
 * spotDL emits "Found N songs in playlist" for the total, then
 * `Downloaded "Title"` / `Skipping "Title"` per song.
 */
export function parseSpotdlProgress(line: string, current: AcquireProgress): AcquireProgress {
  const totalMatch =
    /\bFound (\d+) songs? in\b/i.exec(line) ?? /\bDownloading (\d+) songs? to\b/i.exec(line);
  if (totalMatch) {
    const total = parseInt(totalMatch[1]!, 10);
    if (total > 0) return { done: current.done, total };
  }
  const event = parseSpotdlTrackEvent(line);
  if (event && event.status !== 'failed') {
    return { done: current.done + 1, total: current.total };
  }
  return current;
}

/**
 * Extract a per-track download event from a spotDL output line, if present.
 *
 * - `Downloaded "Artist - Title": <url>` → done
 * - `Skipping Artist - Title (file already exists) <url>` / `(skip file found)`
 *   / `Skipping explicit song: Artist - Title` / legacy `Skipping "…"` → skipped
 * - `LookupError: No results found for song: X` / `AudioProviderError: YT-DLP
 *   download error - <youtube url>` → failed, as spotDL logs them mid-run; the
 *   `--print-errors` summary (`<track url> - <Exception>: <message>`) at the end
 *   repeats each one and parses to the same title, so a consumer keyed on title
 *   counts it once. Other summary exceptions are identified by the track url.
 *
 * The matcher's own `Skipping result due to …` chatter is not a track.
 */
export function parseSpotdlTrackEvent(line: string): DownloaderTrackEvent | null {
  const downloaded = /Downloaded "([^"]+)"/i.exec(line);
  if (downloaded) return { title: downloaded[1]!, status: 'done' };
  const skippingQuoted = /Skipping "([^"]+)"/i.exec(line);
  if (skippingQuoted) return { title: skippingQuoted[1]!, status: 'skipped' };
  const skippingFile = /\bSkipping (.+?) \((?:file already exists|skip file found)\)/i.exec(line);
  if (skippingFile) return { title: skippingFile[1]!.trim(), status: 'skipped' };
  const skippingExplicit = /\bSkipping explicit song:\s*(.+)$/i.exec(line);
  if (skippingExplicit) return { title: skippingExplicit[1]!.trim(), status: 'skipped' };
  // Failures, mid-run or in the `--print-errors` summary: keyed so both forms
  // of the same failure yield the same title (the song name for a lookup miss,
  // the YouTube url for a download error).
  const noResults = /LookupError: No results found for song:\s*(.+?)\s*$/i.exec(line);
  if (noResults) return { title: noResults[1]!, status: 'failed' };
  const ytdlp = /AudioProviderError: YT-DLP download error - (https?:\/\/\S+)/i.exec(line);
  if (ytdlp) {
    return {
      title: ytdlp[1]!,
      status: 'failed',
      detail: 'AudioProviderError: YT-DLP download error',
    };
  }
  const failed = /^(https?:\/\/\S+) - (\w+: .*)$/.exec(line.trim());
  if (failed) return { title: failed[1]!, status: 'failed', detail: failed[2]! };
  return null;
}

/**
 * Extract a playlist title from a yt-dlp output line, if present.
 * yt-dlp emits: `[download] Downloading playlist: My Playlist Title`
 */
export function parseYtdlpPlaylistTitle(line: string): string | null {
  const m = /\[download\] Downloading playlist:\s+(.+)/.exec(line);
  return m ? m[1]!.trim() : null;
}

/**
 * Extract a playlist title from a spotDL output line, if present:
 * `Found N songs in playlist: My Playlist Title`.
 */
export function parseSpotdlPlaylistTitle(line: string): string | null {
  const current = SPOTDL_FOUND_CURRENT.exec(line);
  if (current) return current[2]!.trim();
  const legacy = SPOTDL_FOUND_LEGACY.exec(line);
  return legacy ? legacy[2]!.trim() : null;
}

/**
 * Parse yt-dlp per-track markers emitted by an `--exec`/postprocessor wrapper:
 * `TRACK_START::<title>` when a track begins downloading, `TRACK_DONE::<title>`
 * when it finishes.
 *
 * Newer markers also carry the destination filename after a tab
 * (`TRACK_START::artist - title\ttrack01.mp3`), which resolves the landed file
 * without title-collision guessing. The delimiter is a tab — not a second `::` —
 * because yt-dlp derives the filename from the title, so a title containing
 * `::` would poison both fields of a `::`-delimited marker. Split at the LAST
 * tab; tab-free lines (older markers) still parse, with `path` omitted.
 */
export function parseYtdlpTrackEvent(line: string): DownloaderTrackEvent | null {
  const start = /^TRACK_START::(.+)/.exec(line);
  if (start) return splitMarkerPayload(start[1]!, 'downloading');
  const done = /^TRACK_DONE::(.+)/.exec(line);
  if (done) return splitMarkerPayload(done[1]!, 'done');
  return null;
}

function splitMarkerPayload(payload: string, status: DownloaderTrackStatus): DownloaderTrackEvent {
  const tab = payload.lastIndexOf('\t');
  if (tab === -1) return { title: payload.trim(), status };
  return { title: payload.slice(0, tab).trim(), status, path: payload.slice(tab + 1).trim() };
}
