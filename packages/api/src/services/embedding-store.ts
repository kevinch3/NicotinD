/**
 * Read cached Essentia embeddings out of `library_embeddings` for matchmaking.
 *
 * The embedding is the expensive artifact produced by the audio-features
 * enrichment task (see enrichment/tasks.ts) and stored once per (song, model)
 * as a little-endian Float32 BLOB. The radio scorer reads it as an extra
 * closeness axis (`cosineSim` in radio.service.ts), so this is a thin, pooled
 * batch loader — one query for a whole candidate pool, no per-row round-trips.
 */
import type { Database } from 'bun:sqlite';

interface EmbeddingRow {
  song_id: string;
  vec: Uint8Array;
}

/** Decode a stored BLOB back into a Float32Array (copy — the BLOB is a view). */
function decodeVec(vec: Uint8Array): Float32Array {
  // Copy so the backing buffer is exactly the vector's bytes and 4-byte aligned.
  const bytes = Uint8Array.from(vec);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * The embedding model to compare within. Embeddings only compare against the
 * same model, so we pin the seed's model. Returns null when the seed has none
 * (comparison needs both sides → the whole axis is skipped downstream).
 */
export function embeddingModelFor(db: Database, songId: string): string | null {
  const row = db
    .query<{ model: string }, [string]>(
      `SELECT model FROM library_embeddings WHERE song_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(songId);
  return row?.model ?? null;
}

/**
 * Load embeddings for the given song ids under one model, as a Map keyed by
 * song id. Empty ids (or a null/empty model) short-circuit to an empty map.
 * Chunked so the `IN (...)` list stays well under SQLite's variable limit.
 */
export function loadEmbeddings(
  db: Database,
  ids: readonly string[],
  model: string | null,
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!model || ids.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    // Content check (issue #258): the song id comes from the path, so a file
    // replaced in place keeps its id and would otherwise serve an embedding of
    // audio that is no longer there. `e.file_size IS NOT ... IS NOT s.size`
    // reads as "not a known mismatch" — a row predating the column (NULL) still
    // matches, so an upgrade doesn't invalidate the whole library at once, and
    // `IS` (not `=`) keeps the comparison NULL-safe on both sides.
    const rows = db
      .query<EmbeddingRow, [string, ...string[]]>(
        `SELECT e.song_id, e.vec FROM library_embeddings e
         JOIN library_songs s ON s.id = e.song_id
         WHERE e.model = ? AND e.song_id IN (${placeholders})
           AND (e.file_size IS NULL OR e.file_size IS s.size)`,
      )
      .all(model, ...chunk);
    for (const r of rows) out.set(r.song_id, decodeVec(r.vec));
  }
  return out;
}

/**
 * The model most of a *pool* was analyzed under — the station counterpart of
 * {@link embeddingModelFor}, which pins a single seed song's model.
 *
 * Filter radio has no seed song to pin, so without this there is no model to
 * pass to {@link loadEmbeddings} and the whole embedding axis stays dark (which
 * is exactly what it did before v3). Picking the plurality model keeps the
 * comparison within one vector space; a library mid-migration between models
 * simply scores the majority slice and skips the rest, same as a seed whose
 * model no candidate shares.
 */
export function dominantEmbeddingModel(db: Database, ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const counts = new Map<string, number>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .query<{ model: string; n: number }, string[]>(
        `SELECT model, COUNT(*) AS n FROM library_embeddings
          WHERE song_id IN (${placeholders}) GROUP BY model`,
      )
      .all(...chunk);
    for (const r of rows) counts.set(r.model, (counts.get(r.model) ?? 0) + r.n);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [model, n] of counts) {
    if (n > bestN) {
      best = model;
      bestN = n;
    }
  }
  return best;
}
