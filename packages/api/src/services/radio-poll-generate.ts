import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type {
  RadioPollScenarioSnapshot,
  RadioPollSettings,
  RadioPollSnapshotFeatures,
} from '@nicotind/core';
import {
  RADIO_SONG_SELECT,
  buildSeedRadio,
  rowToSong,
  toFeatures,
  type RadioSongRow,
} from '../routes/radio.js';
import {
  DEFAULT_WEIGHTS,
  explainSimilarity,
  type ScoringWeights,
  type SongFeatures,
} from './radio.service.js';

/** Bounds enforced on `RadioPollSettings` (mirrored in the admin form). */
export const MAX_SCENARIOS = 20;
export const MAX_NEXT_UP = 10;

/** A creation-request problem the route maps to a 400 (vs. an unexpected 500). */
export class RadioPollGenerationError extends Error {}

export interface GeneratedScenario {
  id: string;
  position: number;
  kind: 'seed' | 'filter';
  seedSongId: string | null;
  snapshot: RadioPollScenarioSnapshot;
}

/**
 * Merge partial weight overrides onto the engine defaults, refusing unknown
 * axes / non-finite values — a silent no-op would invalidate the measurement
 * (same stance as dump-radio's `parseWeightOverrides`).
 */
export function mergePollWeights(overrides: Record<string, number> | undefined): ScoringWeights {
  const merged: ScoringWeights = { ...DEFAULT_WEIGHTS };
  for (const [axis, value] of Object.entries(overrides ?? {})) {
    if (!(axis in DEFAULT_WEIGHTS)) {
      throw new RadioPollGenerationError(
        `unknown weight axis "${axis}" (valid: ${Object.keys(DEFAULT_WEIGHTS).join(', ')})`,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RadioPollGenerationError(`weight "${axis}" must be a finite number`);
    }
    merged[axis as keyof ScoringWeights] = value;
  }
  return merged;
}

/**
 * `SongFeatures` → the JSON-safe snapshot shape. `embedding` is a Float32Array
 * (JSON.stringify would persist it as an index-keyed blob) and
 * `recentPlayFactor` is listener-relative; polls generate without a listener.
 */
export function stripFeatures(features: SongFeatures): RadioPollSnapshotFeatures {
  const rest: Partial<SongFeatures> = { ...features };
  delete rest.embedding;
  delete rest.recentPlayFactor;
  return rest as RadioPollSnapshotFeatures;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Settings with counts clamped into range — what gets persisted verbatim. */
export function normalizePollSettings(settings: RadioPollSettings): RadioPollSettings {
  return {
    ...settings,
    scenarioCount: clampInt(settings.scenarioCount, 1, MAX_SCENARIOS, 5),
    nextUpCount: clampInt(settings.nextUpCount, 1, MAX_NEXT_UP, 5),
    pinnedSeedIds: [...new Set((settings.pinnedSeedIds ?? []).filter(Boolean))].slice(
      0,
      MAX_SCENARIOS,
    ),
  };
}

/** dump-radio's auto-seed pick: a random landed, visible song, preferring one
 *  with a genre tag (a genre-less seed scores half the axes as data gaps). */
function pickAutoSeed(db: Database, excludeIds: Set<string>): RadioSongRow | null {
  const marks = [...excludeIds].map(() => '?').join(', ');
  const where = excludeIds.size ? `AND s.id NOT IN (${marks})` : '';
  return (
    db
      .query<RadioSongRow, string[]>(
        `${RADIO_SONG_SELECT}
         WHERE s.hidden = 0 AND s.landed_at IS NOT NULL ${where}
         ORDER BY (s.genre IS NULL), RANDOM() LIMIT 1`,
      )
      .get(...excludeIds) ?? null
  );
}

function seedScenario(
  db: Database,
  seedRow: RadioSongRow,
  position: number,
  nextUpCount: number,
  weights: ScoringWeights,
): GeneratedScenario | null {
  const result = buildSeedRadio(db, seedRow, { count: nextUpCount, weights });
  if (!result.seed || result.ranked.length === 0) return null;
  const snapshot: RadioPollScenarioSnapshot = {
    kind: 'seed',
    seed: { song: rowToSong(seedRow), features: stripFeatures(toFeatures(seedRow)) },
    weights: { ...weights },
    candidates: result.ranked.map((e, i) => ({
      song: rowToSong(e.song._row),
      features: stripFeatures(toFeatures(e.song._row)),
      score: e.score,
      rank: i + 1,
      // Emulates the real queue (rank order) today; kept as its own field so an
      // anti-position-bias shuffle is a generation-time change only.
      displayOrder: i + 1,
      explanation: explainSimilarity(result.seed as SongFeatures, e.song, weights),
    })),
  };
  return { id: randomUUID(), position, kind: 'seed', seedSongId: seedRow.id, snapshot };
}

/**
 * Freeze a poll's scenarios: pinned seeds first (a missing/hidden pin is a 400
 * — the admin named it, silence would misreport the poll), then random
 * genre-preferring auto seeds for the remaining slots. A scenario whose radio
 * comes back empty is dropped (small-library reality); zero scenarios overall
 * is an error.
 */
export function generatePollScenarios(
  db: Database,
  settings: RadioPollSettings,
  weights: ScoringWeights,
): GeneratedScenario[] {
  const scenarios: GeneratedScenario[] = [];
  const usedSeedIds = new Set<string>();

  const pinned = (settings.pinnedSeedIds ?? []).slice(0, settings.scenarioCount);
  for (const seedId of pinned) {
    const row = db
      .query<RadioSongRow, [string]>(
        `${RADIO_SONG_SELECT} WHERE s.id = ? AND s.hidden = 0 AND s.landed_at IS NOT NULL`,
      )
      .get(seedId);
    if (!row) {
      throw new RadioPollGenerationError(`pinned seed song not found or not playable: ${seedId}`);
    }
    usedSeedIds.add(row.id);
    const scenario = seedScenario(db, row, scenarios.length, settings.nextUpCount, weights);
    if (scenario) scenarios.push(scenario);
  }

  while (scenarios.length < settings.scenarioCount) {
    const row = pickAutoSeed(db, usedSeedIds);
    if (!row) break; // library exhausted
    usedSeedIds.add(row.id);
    const scenario = seedScenario(db, row, scenarios.length, settings.nextUpCount, weights);
    if (scenario) scenarios.push(scenario);
  }

  if (scenarios.length === 0) {
    throw new RadioPollGenerationError(
      'no scenarios could be generated — the library has too few playable songs',
    );
  }
  return scenarios;
}
