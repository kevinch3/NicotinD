/**
 * Turn a stored `curation_flags` row into a `CurationCase` the triage UI can
 * render (docs/curator-triage.md "Closed options only").
 *
 * The contract with the human is strict: a card is one sentence plus closed
 * options that each do something. So `flagToCase` returns **null** for a flag
 * with no actionable option — a prose flag, or a typed one whose options all
 * failed validation — and the round never serves it. That flag is still open;
 * it is the agent's unfinished work, visible through `list_review_flags`.
 *
 * `options_json` is text an agent wrote. `validateCaseOptions` refuses a bad
 * blob at write time so the agent learns; `parseOptions` re-checks on read
 * because the stored blob is still a trust boundary (older rows, direct SQL).
 */
import {
  CASE_TEXT_LIMITS,
  isActionableEffect,
  isCurationCaseKind,
  type CaseEffect,
  type CaseOption,
  type CurationCase,
} from '@nicotind/core';
import type { CurationFlag } from '../curation-flags.js';

export type CaseTarget = CurationCase['target'];

/** Effect types this build can actually dispatch. See `applyCaseEffect`. */
const KNOWN_EFFECTS = ['resolve-only', 'song-metadata', 'artist-merge', 'song-delete'] as const;

/**
 * The option the server appends when the agent offered no "change nothing"
 * choice of its own. The web renders its label through i18n, keyed on this id.
 */
export const FALLBACK_OPTION_ID = 'resolve';

const LEAVE_AS_IS: CaseOption = {
  id: FALLBACK_OPTION_ID,
  label: 'Leave as is',
  rationale: 'Close this without changing anything.',
  effect: { type: 'resolve-only' },
};

/** The only tag fields a `song-metadata` effect may carry. */
const SONG_METADATA_FIELDS = new Set(['title', 'artist', 'album', 'albumArtist']);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * A `fields` bag is dispatchable only if every key is a known tag field with a
 * STRING value, and at least one is present. Key-only validation is not enough:
 * a non-string value reaches `normalizeTagValue`, whose unconditional `.trim()`
 * throws — a 500 with the flag left open, rather than a dropped option.
 */
function fieldsProblem(fields: unknown): string | null {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return 'fields must be an object';
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) return 'fields must name at least one tag';
  for (const [k, v] of entries) {
    if (!SONG_METADATA_FIELDS.has(k)) {
      return `fields.${k} is not one of ${[...SONG_METADATA_FIELDS].join('|')}`;
    }
    if (typeof v !== 'string') return `fields.${k} must be a string`;
  }
  return null;
}

/** Why an effect cannot be dispatched, or null when it can. */
function effectProblem(effect: unknown): string | null {
  if (typeof effect !== 'object' || effect === null) return 'effect must be an object';
  const e = effect as Partial<Record<string, unknown>>;
  switch (e.type) {
    case 'resolve-only':
      return null;
    case 'song-metadata':
      if (!nonEmpty(e.songId)) return 'song-metadata needs a songId';
      return fieldsProblem(e.fields);
    case 'artist-merge':
      if (!nonEmpty(e.rawName)) return 'artist-merge needs a rawName';
      if (!nonEmpty(e.mergeInto)) return 'artist-merge needs a mergeInto';
      return null;
    case 'song-delete':
      return nonEmpty(e.songId) ? null : 'song-delete needs a songId';
    default:
      return `unknown effect type ${JSON.stringify(e.type)} (expected ${KNOWN_EFFECTS.join('|')})`;
  }
}

/** Why one option is not a valid card button, or null when it is. */
function optionProblem(o: unknown): string | null {
  if (typeof o !== 'object' || o === null) return 'must be an object';
  const c = o as Partial<Record<string, unknown>>;
  if (!nonEmpty(c.id)) return 'needs an id';
  if (c.id === FALLBACK_OPTION_ID) return `id ${FALLBACK_OPTION_ID} is reserved for the server`;
  if (!nonEmpty(c.label)) return 'needs a label';
  if (c.label.length > CASE_TEXT_LIMITS.label) {
    return `label is over ${CASE_TEXT_LIMITS.label} characters`;
  }
  if (c.rationale !== undefined && typeof c.rationale !== 'string') {
    return 'rationale must be a string';
  }
  if (typeof c.rationale === 'string' && c.rationale.length > CASE_TEXT_LIMITS.rationale) {
    return `rationale is over ${CASE_TEXT_LIMITS.rationale} characters`;
  }
  if (c.destructive !== undefined && typeof c.destructive !== 'boolean') {
    return 'destructive must be a boolean';
  }
  const effect = effectProblem(c.effect);
  return effect ? `effect: ${effect}` : null;
}

/** The stored shape of a validated option — never the caller's object as-is. */
function toOption(o: Record<string, unknown>): CaseOption {
  const effect = o.effect as CaseEffect;
  const option: CaseOption = {
    id: o.id as string,
    label: o.label as string,
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    effect,
  };
  // A delete is destructive whatever the agent wrote; the card's confirm step
  // keys off this, so it is decided here rather than trusted from the blob.
  if (effect.type === 'song-delete' || o.destructive === true) option.destructive = true;
  return option;
}

export type OptionsValidation = { ok: true; options: CaseOption[] } | { ok: false; error: string };

/**
 * Write-time validation of an agent-supplied `options` array. Refuses rather
 * than degrading: an agent that thinks it offered choices and did not would
 * never learn, and the human would get a card with nothing to press.
 */
export function validateCaseOptions(raw: unknown): OptionsValidation {
  if (!Array.isArray(raw))
    return { ok: false, error: 'options must be an array of choice objects' };
  if (raw.length === 0) return { ok: false, error: 'options must hold at least one choice' };
  const seen = new Set<string>();
  const options: CaseOption[] = [];
  for (let i = 0; i < raw.length; i++) {
    const problem = optionProblem(raw[i]);
    if (problem) return { ok: false, error: `options[${i}] ${problem}` };
    const option = toOption(raw[i] as Record<string, unknown>);
    if (seen.has(option.id))
      return { ok: false, error: `options[${i}] duplicates id ${option.id}` };
    seen.add(option.id);
    options.push(option);
  }
  if (!options.some((o) => isActionableEffect(o.effect))) {
    return {
      ok: false,
      error:
        'options must include at least one choice that changes data (song-metadata, artist-merge or song-delete) — a case with nothing to apply is not a decision',
    };
  }
  return { ok: true, options };
}

export type TypedCaseInput =
  | { ok: true; caseKind?: CurationCase['kind']; question?: string; optionsJson?: string }
  | { ok: false; error: string };

/**
 * The typed half of a flag write, shared by the MCP tool and the HTTP route so
 * both refuse the same shapes. `question` and `options` travel together: a
 * question with nothing to press, or buttons with no question over them, is
 * half a card.
 */
export function parseTypedCaseInput(args: {
  caseKind?: unknown;
  question?: unknown;
  options?: unknown;
}): TypedCaseInput {
  const out: { caseKind?: CurationCase['kind']; question?: string; optionsJson?: string } = {};
  if (args.caseKind !== undefined && args.caseKind !== null) {
    if (!isCurationCaseKind(args.caseKind)) {
      return {
        ok: false,
        error: 'caseKind must be one of identity, placement, duplicate, listen, batch',
      };
    }
    out.caseKind = args.caseKind;
  }
  const hasOptions = args.options !== undefined && args.options !== null;
  const hasQuestion = args.question !== undefined && args.question !== null;
  if (hasOptions !== hasQuestion) {
    return { ok: false, error: 'question and options are required together' };
  }
  if (hasOptions) {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return { ok: false, error: 'question must be one non-empty sentence' };
    if (question.length > CASE_TEXT_LIMITS.question) {
      return { ok: false, error: `question is over ${CASE_TEXT_LIMITS.question} characters` };
    }
    const validated = validateCaseOptions(args.options);
    if (!validated.ok) return validated;
    out.question = question;
    out.optionsJson = JSON.stringify(validated.options);
  }
  return { ok: true, ...out };
}

/** Read-side parse: drop anything that cannot be dispatched, keep the rest. */
function parseOptions(json: string | null): CaseOption[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o) => optionProblem(o) === null)
    .map((o) => toOption(o as Record<string, unknown>));
}

/** True when the flag would be served to a human as a card. */
export function flagHasActionableOptions(flag: Pick<CurationFlag, 'optionsJson'>): boolean {
  return parseOptions(flag.optionsJson).some((o) => isActionableEffect(o.effect));
}

/**
 * Build the card, or null when the flag has nothing a human can press. The
 * options are the agent's, in its order; "Leave as is" is appended only when
 * the agent offered no resolve-only choice of its own, so a card never shows
 * two ways of changing nothing.
 */
export function flagToCase(flag: CurationFlag, target: CaseTarget): CurationCase | null {
  const parsed = parseOptions(flag.optionsJson);
  if (!parsed.some((o) => isActionableEffect(o.effect))) return null;

  const evidence = [
    { label: 'Raised by', value: flag.createdBy },
    { label: 'Raised', value: new Date(flag.createdAt).toISOString() },
  ];
  if (flag.source === 'listener' || flag.reportCount > 1) {
    evidence.push({ label: 'Listener reports', value: String(flag.reportCount) });
  }
  const hasOwnKeep = parsed.some((o) => !isActionableEffect(o.effect));

  return {
    id: `flag:${flag.id}`,
    // A case with no declared kind reads as `identity`: the "who/what is this
    // really?" shape, whose card has no kind-specific chrome.
    kind: isCurationCaseKind(flag.caseKind) ? flag.caseKind : 'identity',
    target,
    // A typed row written before `question` existed still has its reason; it
    // is served as the question rather than as an empty line.
    question: flag.question ?? flag.reason,
    details: flag.question ? flag.reason : null,
    evidence,
    options: hasOwnKeep ? parsed : [...parsed, LEAVE_AS_IS],
    confidence: 1,
    source: 'flag',
  };
}
