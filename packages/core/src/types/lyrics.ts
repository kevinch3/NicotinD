/**
 * Stored lyrics for a single library song, as returned by the API. Lyrics are
 * fetched on demand from a lyrics-capable plugin (LRCLIB, …), persisted in the
 * `library_lyrics` side-table, and may be edited by the user.
 */
export interface LyricsDto {
  /** Plain-text lyrics (also written back to the file tag). Null when none. */
  plain: string | null;
  /** Raw LRC (`[mm:ss.xx]` timestamped lines) for karaoke-style highlighting. */
  synced: string | null;
  /** Plugin id that produced the lyrics, or 'user' when manually edited. */
  source: string | null;
  /** True when a user edited the text — protects it from being re-fetched. */
  customized: boolean;
  updatedAt: number;
}
