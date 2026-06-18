/**
 * A single archive.org item returned by the search lane (`GET /api/archive/search`).
 * The `detailsUrl` is what the client passes to `POST /api/acquire` to download it
 * via the `archive` resolve plugin.
 */
export interface ArchiveCandidate {
  identifier: string;
  title: string;
  creator: string;
  year: string | null;
  detailsUrl: string;
  /**
   * Number of audio tracks the item would download (the largest single-format
   * group, mirroring what the `archive` plugin stages). `null` when the per-item
   * metadata lookup was unavailable. Lets the UI show "N tracks" + album/single so
   * the user knows what they'll get before acquiring.
   */
  trackCount?: number | null;
  /** `single` (1 track), `album` (2+), or `null` when the track count is unknown. */
  kind?: 'single' | 'album' | null;
}
