/**
 * Named recommendation strategies and the player's variety control.
 *
 * A strategy is a complete recipe for one radio generation — pool mix, weight
 * overrides, per-artist cap, out-of-genre quota — chosen by name so the client,
 * the diagnostic dump and the poll harness all speak the same vocabulary. The
 * definitions live in the API (`services/recommendation/strategies.ts`); this
 * module carries only the ids and the one mapping both sides need.
 *
 * The player's control speaks in *complaints* ("too similar", "too different")
 * while a strategy is a *remedy* (`different`, `similar`). Keeping the
 * inversion in exactly one tested function is what stops it shipping inverted.
 */
export const STRATEGY_IDS = ['similar', 'balanced', 'different'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const VARIETIES = ['too-similar', 'balanced', 'too-different'] as const;
export type Variety = (typeof VARIETIES)[number];

export const DEFAULT_STRATEGY: StrategyId = 'balanced';

export function isStrategyId(v: unknown): v is StrategyId {
  return typeof v === 'string' && (STRATEGY_IDS as readonly string[]).includes(v);
}

/** "It's too similar" asks for the `different` strategy, and vice versa. */
export function strategyForVariety(v: Variety): StrategyId {
  switch (v) {
    case 'too-similar':
      return 'different';
    case 'too-different':
      return 'similar';
    default:
      return 'balanced';
  }
}

/** The control position that produced a strategy (the inverse mapping). */
export function varietyForStrategy(s: StrategyId): Variety {
  switch (s) {
    case 'different':
      return 'too-similar';
    case 'similar':
      return 'too-different';
    default:
      return 'balanced';
  }
}
