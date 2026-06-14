/** Result of on-demand BPM analysis for a single library song. */
export interface BpmAnalysisResult {
  /** Detected (or tag-read) beats per minute, rounded. Null when undetectable. */
  bpm: number | null;
  /** Where the value came from: an existing tag, or fresh audio analysis. */
  source: 'tag' | 'analyzed';
}

/**
 * On-demand genre check against an external source (Lidarr/MusicBrainz). The
 * current value is the file's own tag; `suggested` is what the source proposes
 * (null when the source is unconfigured or has nothing).
 */
export interface GenreSuggestion {
  current: string | null;
  suggested: string | null;
  /** All candidate genres the source returned, best-first. */
  candidates: string[];
  /** Where the suggestion came from, or null when unavailable. */
  source: 'lidarr' | null;
}
