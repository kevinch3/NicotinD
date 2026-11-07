/**
 * Named recommendation strategies and the player's variety control.
 *
 * A strategy is a complete recipe for one radio generation — pool mix, weight
 * overrides, per-artist cap, out-of-genre quota — chosen by name so the client,
 * the diagnostic dump and the poll harness all speak the same vocabulary. The
 * definitions live in the API (`services/recommendation/strategies.ts`); this
 * module carries only the ids and the one mapping both sides need.
 *
 * The player's control is a dial — Close · Medium · Far (#1660). Left to right
 * is closer to farther, the same order as STRATEGY_IDS, so the mapping is
 * monotone and lives in exactly one tested function.
 */
export const STRATEGY_IDS = ['similar', 'balanced', 'different'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const VARIETIES = ['close', 'medium', 'far'] as const;
export type Variety = (typeof VARIETIES)[number];

export const DEFAULT_STRATEGY: StrategyId = 'balanced';

export function isStrategyId(v: unknown): v is StrategyId {
  return typeof v === 'string' && (STRATEGY_IDS as readonly string[]).includes(v);
}

/** Close plays `similar`, Medium `balanced`, Far `different`. */
export function strategyForVariety(v: Variety): StrategyId {
  switch (v) {
    case 'close':
      return 'similar';
    case 'far':
      return 'different';
    default:
      return 'balanced';
  }
}

/** The dial position that produced a strategy (the inverse mapping). */
export function varietyForStrategy(s: StrategyId): Variety {
  switch (s) {
    case 'similar':
      return 'close';
    case 'different':
      return 'far';
    default:
      return 'medium';
  }
}
