/**
 * How often people accept what an unattended token proposes (#1516 P6).
 *
 * A `refiner:auto` token files genre cards; a person picks an option or
 * dismisses the card. The share of its judged cards where the person picked the
 * token's **first** option is the token's measured precision, and a token may
 * write genres by itself only once that number is earned. The model is
 * untrusted: this is the server measuring it, not the model vouching for itself.
 *
 * Measured per token, not per model name. A token is the unit the server can
 * identify; use one token per model. → docs/curator-runner.md "Earning auto-apply"
 */
import type { Database } from 'bun:sqlite';

export const AUTO_APPLY_GATE = {
  /** Judged cards a token needs before its rate means anything. */
  minJudged: 20,
  /** Share of judged cards where the person picked the token's first option. */
  minAccepted: 0.9,
} as const;

export interface AgentPrecision {
  tokenId: string;
  /** Genre cards the token filed. */
  proposed: number;
  /** Still open: not judged yet. */
  open: number;
  /** The person picked the token's first option. */
  accepted: number;
  /** The person picked another option. */
  corrected: number;
  /** The person closed the card without picking any option. */
  dismissed: number;
  /** accepted + corrected + dismissed. */
  judged: number;
  /** accepted / judged, or null with nothing judged. */
  precision: number | null;
  /** Whether the token may write genres by itself. */
  autoApply: boolean;
}

interface FlagRow {
  created_by: string;
  options_json: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolved_option: string | null;
}

/** The id of a card's first option when the card proposes genres, else null. */
function firstGenreOption(optionsJson: string | null): string | null {
  if (!optionsJson) return null;
  try {
    const options = JSON.parse(optionsJson) as Array<{ id?: string; effect?: { type?: string } }>;
    const first = options[0];
    return first?.effect?.type === 'song-genre' && typeof first.id === 'string' ? first.id : null;
  } catch {
    return null;
  }
}

/** A resolution by a person, not by a run revert or another automated pass. */
function isHumanResolver(resolvedBy: string | null): boolean {
  return !!resolvedBy && !/^(agent|run-revert|task):/.test(resolvedBy);
}

/** Precision per unattended token, most proposals first; one token when `tokenId` is given. */
export function agentPrecision(db: Database, tokenId?: string): AgentPrecision[] {
  const rows = db
    .query<FlagRow, [string]>(
      `SELECT created_by, options_json, resolved_at, resolved_by, resolved_option
         FROM curation_flags
        WHERE created_by LIKE ? AND options_json IS NOT NULL`,
    )
    .all(tokenId ? `agent:${tokenId}` : 'agent:%');
  const byToken = new Map<string, AgentPrecision>();
  for (const r of rows) {
    const first = firstGenreOption(r.options_json);
    if (!first) continue;
    const id = r.created_by.slice('agent:'.length);
    let p = byToken.get(id);
    if (!p) {
      p = {
        tokenId: id,
        proposed: 0,
        open: 0,
        accepted: 0,
        corrected: 0,
        dismissed: 0,
        judged: 0,
        precision: null,
        autoApply: false,
      };
      byToken.set(id, p);
    }
    p.proposed++;
    if (r.resolved_at === null) p.open++;
    // A card an automated pass closed (a run revert) says nothing about the proposal.
    else if (!isHumanResolver(r.resolved_by)) continue;
    else if (r.resolved_option === null) p.dismissed++;
    else if (r.resolved_option === first) p.accepted++;
    else p.corrected++;
  }
  for (const p of byToken.values()) {
    p.judged = p.accepted + p.corrected + p.dismissed;
    p.precision = p.judged > 0 ? p.accepted / p.judged : null;
    p.autoApply =
      p.judged >= AUTO_APPLY_GATE.minJudged &&
      p.precision !== null &&
      p.precision >= AUTO_APPLY_GATE.minAccepted;
  }
  return [...byToken.values()].sort(
    (a, b) => b.proposed - a.proposed || a.tokenId.localeCompare(b.tokenId),
  );
}

/**
 * The refusal for an unattended token that has not earned writing by itself,
 * else null. The text carries the measured numbers and the alternative, so a
 * runner can fall back to a card.
 */
export function autoApplyRefusal(db: Database, tokenId: string): string | null {
  const p = agentPrecision(db, tokenId)[0];
  if (p?.autoApply) return null;
  const judged = p?.judged ?? 0;
  const accepted = p?.accepted ?? 0;
  const pct = Math.round(AUTO_APPLY_GATE.minAccepted * 100);
  return (
    `Auto-apply not earned: ${accepted} of ${judged} judged proposals from this token were ` +
    `accepted. It needs at least ${AUTO_APPLY_GATE.minJudged} judged and ${pct}% accepted. ` +
    'Propose it as a card with flag_for_review instead.'
  );
}
