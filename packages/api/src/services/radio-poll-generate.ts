import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { describeLibraryFilter, isStrategyId } from '@nicotind/core';
import type {
  LibraryFilter,
  RadioPollScenarioSnapshot,
  RadioPollSettings,
  RadioPollSnapshotFeatures,
} from '@nicotind/core';
import {
  RADIO_SONG_SELECT,
  buildFilterRadio,
  buildSeedRadio,
  rowToSong,
  toFeatures,
  type RadioSongRow,
} from '../routes/radio.js';
import { feedEligibilitySql } from './recommendation/eligibility.js';
import { resolveStrategy, type RecommendationStrategy } from './recommendation/strategies.js';
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
export function mergePollWeights(
  overrides: Record<string, number> | undefined,
  base: ScoringWeights = DEFAULT_WEIGHTS,
): ScoringWeights {
  const merged: ScoringWeights = { ...base };
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
 * (JSON.stringify would persist it as an index-keyed blob), `recentPlayFactor`
 * is listener-relative (polls generate without a listener), and `recordingKey`
 * is derived from fields the snapshot already carries.
 *
 * This is a delete-list over a spread, so a new `SongFeatures` field lands in
 * every persisted snapshot unless it is dropped here. Its test asserts the
 * exact output shape — keep it that way.
 */
export function stripFeatures(features: SongFeatures): RadioPollSnapshotFeatures {
  const rest: Partial<SongFeatures> = { ...features };
  delete rest.embedding;
  delete rest.recentPlayFactor;
  delete rest.recordingKey;
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
    filters: (settings.filters ?? [])
      .filter((f) => f && Object.keys(f).length > 0)
      .slice(0, MAX_SCENARIOS),
    // Server-authoritative like formulaVersion: every new poll is stars5
    // (issue #800 — binary consensus measurably starved the eval of pairs).
    voteScale: 'stars5',
    // Unknown → dropped (= balanced); the admin route 400s before reaching here.
    strategy: isStrategyId(settings.strategy) ? settings.strategy : undefined,
  };
}

/**
 * A rater-facing name for a station. Deliberately terse and human ("Electronic",
 * "happy · 120+ bpm") — the wizard shows it where a seed track's card would be,
 * and a JSON blob there tells a rater nothing about what they are grading.
 */
export function describeFilter(filter: LibraryFilter): string {
  return describeLibraryFilter(filter);
}

/** dump-radio's auto-seed pick: a random landed, visible song, preferring one
 *  with a genre tag (a genre-less seed scores half the axes as data gaps). */
function pickAutoSeed(db: Database, excludeIds: Set<string>): RadioSongRow | null {
  const marks = [...excludeIds].map(() => '?').join(', ');
  const where = excludeIds.size ? `AND s.id NOT IN (${marks})` : '';
  // A vetted seed scores every axis; only a library with none falls back to
  // an un-analysed one (same tier rule as the radio pool it will be run through).
  for (const tier of [1, 2] as const) {
    const row = db
      .query<RadioSongRow, string[]>(
        `${RADIO_SONG_SELECT}
         WHERE ${feedEligibilitySql({ alias: 's', albumAlias: 'a', tier })} ${where}
         ORDER BY (s.genre IS NULL), RANDOM() LIMIT 1`,
      )
      .get(...excludeIds);
    if (row) return row;
  }
  return null;
}

function seedScenario(
  db: Database,
  seedRow: RadioSongRow,
  position: number,
  nextUpCount: number,
  weights: ScoringWeights,
  strategy: RecommendationStrategy,
): GeneratedScenario | null {
  const result = buildSeedRadio(db, seedRow, { count: nextUpCount, weights, strategy });
  if (!result.seed || result.ranked.length === 0) return null;
  const snapshot: RadioPollScenarioSnapshot = {
    kind: 'seed',
    seed: { song: rowToSong(seedRow), features: stripFeatures(toFeatures(seedRow)) },
    weights: { ...weights },
    strategy: strategy.id,
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
 * A station scenario: the same freeze as `seedScenario`, but the "seed" a rater
 * is judging against is a *filter* (a genre/vibe), and the scoring seed is the
 * pool centroid + station anchor `buildFilterRadio` derives from it.
 *
 * Stations were the reserved half of this schema from the start and nothing
 * ever generated one, so every vote collected to date graded seed radio only —
 * which is exactly the path that was NOT the reported problem (see docs/radio.md
 * "Stations").
 */
function filterScenario(
  db: Database,
  filter: LibraryFilter,
  position: number,
  nextUpCount: number,
  weights: ScoringWeights,
  strategy: RecommendationStrategy,
): GeneratedScenario | null {
  const result = buildFilterRadio(db, filter, { count: nextUpCount, weights, strategy });
  if (!result.seed || result.ranked.length === 0) return null;
  const seed = result.seed;
  const snapshot: RadioPollScenarioSnapshot = {
    kind: 'filter',
    seed: null,
    centroid: stripFeatures(seed),
    filter,
    weights: { ...weights },
    strategy: strategy.id,
    candidates: result.ranked.map((e, i) => ({
      song: rowToSong(e.song._row),
      // From the row, like seedScenario — spreading the candidate itself would
      // carry `_row` (file path included) into the snapshot and every export.
      // The station grade is computed, not derivable from the row, so it is
      // re-attached explicitly.
      features: stripFeatures({
        ...toFeatures(e.song._row),
        ...(e.song.stationAffinity !== undefined
          ? { stationAffinity: e.song.stationAffinity }
          : {}),
      }),
      score: e.score,
      rank: i + 1,
      displayOrder: i + 1,
      explanation: explainSimilarity(seed, e.song, weights),
    })),
  };
  return { id: randomUUID(), position, kind: 'filter', seedSongId: null, snapshot };
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
  const strategy = resolveStrategy(settings.strategy);

  const pinned = (settings.pinnedSeedIds ?? []).slice(0, settings.scenarioCount);
  for (const seedId of pinned) {
    const row = db
      .query<RadioSongRow, [string]>(
        `${RADIO_SONG_SELECT} WHERE s.id = ? AND ${feedEligibilitySql({ alias: 's', albumAlias: 'a', tier: 2 })}`,
      )
      .get(seedId);
    if (!row) {
      throw new RadioPollGenerationError(`pinned seed song not found or not playable: ${seedId}`);
    }
    usedSeedIds.add(row.id);
    const scenario = seedScenario(
      db,
      row,
      scenarios.length,
      settings.nextUpCount,
      weights,
      strategy,
    );
    if (scenario) scenarios.push(scenario);
  }

  // Stations next: an admin who asked for them asked deliberately, so they
  // outrank the random auto seeds for the remaining slots.
  for (const filter of settings.filters ?? []) {
    if (scenarios.length >= settings.scenarioCount) break;
    const scenario = filterScenario(
      db,
      filter,
      scenarios.length,
      settings.nextUpCount,
      weights,
      strategy,
    );
    if (scenario) scenarios.push(scenario);
  }

  while (scenarios.length < settings.scenarioCount) {
    const row = pickAutoSeed(db, usedSeedIds);
    if (!row) break; // library exhausted
    usedSeedIds.add(row.id);
    const scenario = seedScenario(
      db,
      row,
      scenarios.length,
      settings.nextUpCount,
      weights,
      strategy,
    );
    if (scenario) scenarios.push(scenario);
  }

  if (scenarios.length === 0) {
    throw new RadioPollGenerationError(
      'no scenarios could be generated — the library has too few playable songs',
    );
  }
  return scenarios;
}
