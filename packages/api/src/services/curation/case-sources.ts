/**
 * Turn a stored `curation_flags` row into a `CurationCase` the triage UI can
 * render (docs/curator-triage.md).
 *
 * A flag filed before typed cases existed — or by anything that did not fill
 * `case_kind` / `options_json` — is not an error: it becomes a read-and-resolve
 * card, exactly today's behaviour. The parse is deliberately defensive because
 * `options_json` is free-form text an agent wrote: a malformed blob, or one
 * naming an effect this build does not implement, degrades to resolve-only
 * rather than surfacing an option whose apply path does not exist.
 */
import { isCurationCaseKind, type CaseOption, type CurationCase } from '@nicotind/core';
import type { CurationFlag } from '../curation-flags.js';

export type CaseTarget = CurationCase['target'];

/** Effect types this build can actually dispatch. See `applyCaseEffect`. */
const KNOWN_EFFECTS = new Set(['resolve-only', 'song-metadata', 'artist-merge']);

const RESOLVE_ONLY: CaseOption = {
  id: 'resolve',
  label: 'Mark handled',
  rationale: 'No data change — record that this was reviewed.',
  effect: { type: 'resolve-only' },
};

/**
 * Validate that an effect object has all required fields for its type.
 * Returns true only if the effect can be safely dispatched.
 */
function isDispatchableEffect(effect: unknown): boolean {
  if (typeof effect !== 'object' || effect === null) return false;
  const e = effect as Partial<Record<string, unknown>>;
  const type = e.type;

  if (type === 'resolve-only') {
    return true;
  }
  if (type === 'song-metadata') {
    return (
      typeof e.songId === 'string' &&
      e.songId.length > 0 &&
      typeof e.fields === 'object' &&
      e.fields !== null
    );
  }
  if (type === 'artist-merge') {
    return (
      typeof e.mergeInto === 'string' &&
      e.mergeInto.length > 0 &&
      typeof e.rawName === 'string' &&
      e.rawName.length > 0
    );
  }
  return false;
}

function parseOptions(json: string | null): CaseOption[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is CaseOption => {
    if (typeof o !== 'object' || o === null) return false;
    const c = o as Partial<CaseOption>;
    const effectType = (c.effect as { type?: unknown } | undefined)?.type;
    return (
      typeof c.id === 'string' &&
      typeof c.label === 'string' &&
      typeof c.rationale === 'string' &&
      typeof effectType === 'string' &&
      KNOWN_EFFECTS.has(effectType) &&
      isDispatchableEffect(c.effect)
    );
  });
}

export function flagToCase(flag: CurationFlag, target: CaseTarget): CurationCase {
  const parsed = parseOptions(flag.optionsJson);
  const evidence = [
    { label: 'Raised by', value: flag.createdBy },
    { label: 'Raised', value: new Date(flag.createdAt).toISOString() },
  ];
  if (flag.source === 'listener' || flag.reportCount > 1) {
    evidence.push({ label: 'Listener reports', value: String(flag.reportCount) });
  }

  return {
    id: `flag:${flag.id}`,
    // A prose flag has no declared kind. `identity` is the honest default: it
    // is the "who/what is this really?" shape, and its card renders question +
    // evidence + options with no kind-specific chrome.
    kind: isCurationCaseKind(flag.caseKind) ? flag.caseKind : 'identity',
    target,
    question: flag.reason,
    evidence,
    options: [...parsed, RESOLVE_ONLY],
    confidence: 1,
    source: 'flag',
  };
}
