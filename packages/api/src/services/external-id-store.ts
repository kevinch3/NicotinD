/**
 * Persisted non-MusicBrainz external ids (issue #194).
 *
 * library_mbids stays MusicBrainz-specific (it's heavily referenced and carries
 * its own source-rank downgrade discipline). This general table holds
 * provider-scoped ids (Discogs release/master, …) so a match "locks in" once
 * made — the entire benefit over #187 A1, which re-runs its fuzzy release gate
 * every enrichment window. One table for every provider, not a migration per
 * provider (the shape a single-provider library_artist_discogs_id would have
 * forced twice over: artist-keyed for release-level lookups, and one table each).
 */

import type { Database } from 'bun:sqlite';

export type ExternalIdScope = 'release' | 'artist';
export type ExternalIdSource = 'mbid' | 'name-search';

export interface ExternalIdRow {
  provider: string;
  scope: ExternalIdScope;
  key: string;
  externalId: string;
  source: ExternalIdSource;
}

/** Store (or overwrite) a provider id. A re-fetch updates it in place. */
export function upsertExternalId(db: Database, row: ExternalIdRow): void {
  db.run(
    `INSERT INTO library_external_ids (provider, scope, key, external_id, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, scope, key) DO UPDATE SET
       external_id = excluded.external_id,
       source = excluded.source,
       fetched_at = excluded.fetched_at`,
    [row.provider, row.scope, row.key, row.externalId, row.source, Date.now()],
  );
}

export function getExternalId(
  db: Database,
  provider: string,
  scope: ExternalIdScope,
  key: string,
): ExternalIdRow | null {
  let r;
  try {
    r = db
      .query<
        { provider: string; scope: string; key: string; external_id: string; source: string },
        [string, string, string]
      >(
        `SELECT provider, scope, key, external_id, source FROM library_external_ids
         WHERE provider = ? AND scope = ? AND key = ?`,
      )
      .get(provider, scope, key);
  } catch {
    return null;
  }
  if (!r) return null;
  return {
    provider: r.provider,
    scope: r.scope as ExternalIdScope,
    key: r.key,
    externalId: r.external_id,
    source: r.source as ExternalIdSource,
  };
}
