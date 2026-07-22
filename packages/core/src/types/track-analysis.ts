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

/**
 * On-demand licence detection for a single song. `current` is the stored value;
 * `suggested` is a canonical LICENCE_VOCAB code resolved from the file's own
 * LICENSE/COPYRIGHT tag or a MusicBrainz `license` relation (null when nothing
 * confident was found).
 */
export interface LicenceSuggestion {
  current: string | null;
  suggested: string | null;
  /** Where the suggestion came from, or null when nothing was found. */
  source: 'tag' | 'musicbrainz' | null;
}
