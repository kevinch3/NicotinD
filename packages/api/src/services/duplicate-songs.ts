import type { Database } from 'bun:sqlite';
import { normalizeTitle } from '@nicotind/core';

/**
 * Song-level duplicate candidates (#951): one rule for the Admin finder
 * (`GET /api/library/duplicates`) and the health report's `duplicateSongs`
 * dimension, so the count and the worklist it points at cannot disagree.
 *
 * A candidate cluster is songs whose folded artist+title match and whose
 * durations sit within {@link DUPLICATE_DURATION_TOLERANCE_SEC} of the
 * cluster's first member. That is a heuristic, not identity: the fingerprint
 * sample in #951 confirmed its strongest tier, not every candidate, so nothing
 * here deletes — the finder pre-selects, a person decides.
 */
export const DUPLICATE_DURATION_TOLERANCE_SEC = 2;

export interface DuplicateCandidate {
  title: string;
  artist: string;
  duration?: number;
  suffix?: string;
  bitRate?: number;
}

/**
 * Group key, or `null` when the row cannot be identified. Callers MUST treat
 * `null` as "groups with nothing" — the finder pre-arms every non-best member
 * of a group for deletion, so a row that folds to nothing must never join one.
 * → docs/library-processing.md
 */
export function normalizeDupKey(title: string, artist: string): string | null {
  const t = normalizeTitle(title);
  const a = normalizeTitle(artist);
  if (!t || !a) return null;
  return `${t}|||${a}`;
}

/** Higher is the copy to keep: lossless over lossy containers, then bitrate. */
export function qualityScore(song: Pick<DuplicateCandidate, 'suffix' | 'bitRate'>): number {
  const ext = (song.suffix ?? '').toLowerCase();
  const formatScore =
    ext === 'flac' || ext === 'wav' || ext === 'aiff' || ext === 'ape' || ext === 'wv'
      ? 200
      : ext === 'opus' || ext === 'ogg' || ext === 'm4a' || ext === 'aac'
        ? 100
        : 0;
  return formatScore + (song.bitRate ?? 0);
}

/** Clusters of 2+ candidates, each sorted best copy first. */
export function clusterDuplicateSongs<T extends DuplicateCandidate>(songs: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const song of songs) {
    const key = normalizeDupKey(song.title, song.artist);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(song);
    groups.set(key, group);
  }
  const out: T[][] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const clusters: T[][] = [];
    for (const song of group) {
      const home = clusters.find(
        (c) =>
          Math.abs((song.duration ?? 0) - (c[0]?.duration ?? 0)) <=
          DUPLICATE_DURATION_TOLERANCE_SEC,
      );
      if (home) home.push(song);
      else clusters.push([song]);
    }
    for (const c of clusters) {
      if (c.length >= 2) out.push(c.sort((a, b) => qualityScore(b) - qualityScore(a)));
    }
  }
  return out;
}

export interface DuplicateSongFacts {
  metric: { clusters: number; redundantFiles: number };
  /** Largest clusters first. */
  worklist: Array<{ title: string; artist: string; copies: number; albums: string[] }>;
}

/** The health report's view of the same clusters the Admin finder lists. */
export function duplicateSongFacts(db: Database, sample: number): DuplicateSongFacts {
  const rows = db
    .query<
      {
        title: string;
        artist: string;
        duration: number;
        suffix: string | null;
        bit_rate: number | null;
        album: string | null;
      },
      []
    >(
      `SELECT s.title, s.artist, s.duration, s.suffix, s.bit_rate, a.name AS album
         FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
        WHERE s.hidden = 0 AND (a.hidden IS NULL OR a.hidden = 0)`,
    )
    .all()
    .map((r) => ({
      title: r.title,
      artist: r.artist,
      duration: r.duration,
      suffix: r.suffix ?? undefined,
      bitRate: r.bit_rate ?? undefined,
      album: r.album ?? '',
    }));
  const clusters = clusterDuplicateSongs(rows);
  return {
    metric: {
      clusters: clusters.length,
      redundantFiles: clusters.reduce((n, c) => n + c.length - 1, 0),
    },
    worklist: [...clusters]
      .sort((a, b) => b.length - a.length || a[0]!.title.localeCompare(b[0]!.title))
      .slice(0, sample)
      .map((c) => ({
        title: c[0]!.title,
        artist: c[0]!.artist,
        copies: c.length,
        albums: [...new Set(c.map((s) => s.album))],
      })),
  };
}
