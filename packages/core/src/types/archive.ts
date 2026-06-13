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
}
