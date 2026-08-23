/**
 * Per-song audio descriptors (timbre / groove / spectral balance) from the
 * analysis sidecar's `POST /descriptors`, stored once per song in
 * `library_song_descriptors` as the RAW named values the sidecar returned.
 *
 * Why a side table with one JSON column, not ~40 columns on `library_songs`:
 * only three composite radio axes consume these, and every column on the main
 * table is a 13-step contract (scanner COALESCE upsert, tag mirror, DTO, filter
 * grammar, poll snapshot …). Raw rather than pre-normalised so the z-score
 * constants (descriptor-norm.ts, phase 2) can be re-measured without
 * re-analysing the library. The pooled loader mirrors embedding-store.ts —
 * one query per candidate pool, the #258 content check, chunked IN lists.
 * See docs/audio-descriptors.md.
 */
import type { Database } from 'bun:sqlite';

/**
 * Mirrors `DESCRIPTOR_VERSION` in packages/analysis/app/descriptors.py. A row
 * stored under an older version is invisible to the loader and pending for
 * the task, so a changed definition never mixes into one axis.
 */
export const DESCRIPTOR_VERSION = 1;

/** Flat named values; `null` = the sidecar could not define that one. */
export type DescriptorFeatures = Record<string, number | null>;

interface DescriptorRow {
  song_id: string;
  features: string;
}

export function upsertDescriptors(
  db: Database,
  row: { songId: string; version: number; features: DescriptorFeatures; fileSize: number | null },
): void {
  db.run(
    `INSERT OR REPLACE INTO library_song_descriptors (song_id, version, features, file_size, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [row.songId, row.version, JSON.stringify(row.features), row.fileSize, Date.now()],
  );
}

/**
 * SQL predicate (no leading AND, no bind params) selecting songs that still
 * need a descriptor pass: no row, a row under an older version, or a row
 * whose recorded size no longer matches the file (#258). A row with no
 * recorded size counts as done, matching {@link loadDescriptors}.
 */
export function descriptorsPendingClause(alias = 'library_songs'): string {
  return `NOT EXISTS (
    SELECT 1 FROM library_song_descriptors d
     WHERE d.song_id = ${alias}.id AND d.version = ${DESCRIPTOR_VERSION}
       AND (d.file_size IS NULL OR d.file_size IS ${alias}.size)
  )`;
}

/**
 * Load current-version descriptors for a pool of song ids. Same guards as the
 * embedding loader: a size mismatch hides the row (the file was replaced in
 * place and kept its path-derived id), a NULL size is trusted.
 */
export function loadDescriptors(
  db: Database,
  ids: readonly string[],
): Map<string, DescriptorFeatures> {
  const out = new Map<string, DescriptorFeatures>();
  if (ids.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .query<DescriptorRow, [number, ...string[]]>(
        `SELECT d.song_id, d.features FROM library_song_descriptors d
         JOIN library_songs s ON s.id = d.song_id
         WHERE d.version = ? AND d.song_id IN (${placeholders})
           AND (d.file_size IS NULL OR d.file_size IS s.size)`,
      )
      .all(DESCRIPTOR_VERSION, ...chunk);
    for (const r of rows) {
      try {
        out.set(r.song_id, JSON.parse(r.features) as DescriptorFeatures);
      } catch {
        /* a corrupt row reads as absent; the pending clause re-analyses it on version bump */
      }
    }
  }
  return out;
}
