/**
 * Radio provenance — how the queue you are hearing was actually produced.
 *
 * WHY THIS EXISTS. `RADIO_FORMULA_VERSION` lived only on the server and in the
 * poll harness, so neither the listener nor a bug report could say which radio
 * ran. That was tolerable while there was one radio; it stops being tolerable
 * once the genre axis is a setting (docs/genre-affinity.md), because the same
 * seed then yields different queues depending on a flag the listener cannot
 * see. A screenshot should be self-describing.
 *
 * Note `genreAxis` reports what the generation **used**, not what was
 * requested: the learned axis is skipped when a library has no centroids for
 * the genres in play, and a station replaces the genre axis outright, so
 * "requested learned" and "scored learned" are different facts and only the
 * second one explains a queue.
 */
import type { StrategyId } from './radio-strategy.js';

/**
 * Which rule scored the genre axis.
 * - `lexical` — the name-matching rule (exact / token containment / Jaccard).
 * - `learned` — centroid affinity from the library's own audio.
 * - `station` — neither: a filter radio grades genre *membership* instead.
 */
export type RadioGenreAxis = 'lexical' | 'learned' | 'station';

/** Which generator produced the queue — it explains the axis. */
export type RadioLane = 'seed' | 'list' | 'filter';

export interface RadioProvenance {
  /** `RADIO_FORMULA_VERSION` of the server that generated this queue. */
  formulaVersion: number;
  /** The rule that actually scored the genre axis, not the one requested. */
  genreAxis: RadioGenreAxis;
  /** The variety recipe in force (weights + pool mix). */
  strategy: StrategyId;
  lane: RadioLane;
}
