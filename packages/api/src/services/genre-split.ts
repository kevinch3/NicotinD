/**
 * Pure multi-genre tag parsing + normalization. A raw file genre value (one or
 * more frames, possibly `;`/`,`/`|`-joined inside a frame) is split into a
 * clean ordered list of genres, with a human-gated alias table handling
 * everything deterministic rules can't (concatenations, junk, misspellings) —
 * same propose→review→apply philosophy as `library_artist_aliases`.
 */

import type { Database } from 'bun:sqlite';

export interface GenreContext {
  /**
   * genreKey(alias) → canonical. Canonical may itself be a `;`-joined list
   * (one alias expands to many genres, e.g. "RockPunk" → "Rock;Punk") or the
   * empty string (junk value dropped, e.g. "Other" → "").
   */
  aliases: ReadonlyMap<string, string>;
  /** genreKey(name) → display casing (the canonical spelling to emit). */
  known: ReadonlyMap<string, string>;
}

/** Case/whitespace-insensitive matching key for a genre name. */
export function genreKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function emptyGenreContext(): GenreContext {
  return { aliases: new Map(), known: new Map() };
}

// Hard separators always split; `&` never splits (R&B, Drum & Bass); `/` is
// handled separately because it is ambiguous ("Nu Disco / Disco" vs "AC/DC").
const SEPARATORS = /[;,|]/;

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');

/**
 * Batch vocabulary from raw genre values: split on the hard separators only
 * (never `/` — sides of an unresolved slash join must not become "known" and
 * unlock the `/` rule on themselves) and pick the most common casing of each
 * name as its display form.
 */
export function buildKnownFromRaw(
  rawValues: Iterable<string | string[] | undefined>,
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const raw of rawValues) {
    const frames = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const part of frames.flatMap((f) => f.split(SEPARATORS)).map(norm).filter(Boolean)) {
      const k = genreKey(part);
      const variants = counts.get(k) ?? new Map<string, number>();
      variants.set(part, (variants.get(part) ?? 0) + 1);
      counts.set(k, variants);
    }
  }
  const known = new Map<string, string>();
  for (const [k, variants] of counts) {
    known.set(k, [...variants.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
  }
  return known;
}

export function splitGenres(raw: string | string[] | undefined, ctx: GenreContext): string[] {
  const frames = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  let parts = frames.flatMap((f) => f.split(SEPARATORS)).map(norm).filter(Boolean);

  // Alias expansion: canonical may be a list (re-split) or '' (drop). Applied
  // twice so an alias produced by another alias's expansion still resolves.
  const aliasApply = (ps: string[]): string[] =>
    ps.flatMap((p) => {
      const canonical = ctx.aliases.get(genreKey(p));
      if (canonical === undefined) return [p];
      return canonical.split(SEPARATORS).map(norm).filter(Boolean);
    });
  parts = aliasApply(aliasApply(parts));

  // `/` splits only when EVERY side is a known genre (library vocabulary,
  // alias, or alias canonical) — protects "Deep House / Vinyl"-style junk and
  // one-genre names, while "Pop/Rock" or "Nu Disco / Disco" split cleanly.
  const canonicalKeys = new Set(
    [...ctx.aliases.values()].flatMap((v) => v.split(SEPARATORS)).map(genreKey),
  );
  const isKnown = (s: string): boolean => {
    const k = genreKey(s);
    return ctx.known.has(k) || ctx.aliases.has(k) || canonicalKeys.has(k);
  };
  parts = parts.flatMap((p) => {
    if (!p.includes('/')) return [p];
    const sides = p.split('/').map(norm).filter(Boolean);
    return sides.length > 1 && sides.every(isKnown) ? aliasApply(sides) : [p];
  });

  // Case-insensitive de-dupe preserving first-seen order; emit display casing.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = genreKey(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(ctx.known.get(k) ?? p);
  }
  return out;
}

/**
 * Load the genre context from the db: the human-gated alias table plus the
 * current library genre vocabulary (post-split names, so display casing is
 * whatever the last scan settled on). Missing tables → empty (fresh db).
 */
export function loadGenreContext(db: Database): GenreContext {
  const aliases = new Map<string, string>();
  const known = new Map<string, string>();
  try {
    for (const r of db
      .query<{ alias: string; canonical: string }, []>(
        `SELECT alias, canonical FROM library_genre_aliases`,
      )
      .all()) {
      aliases.set(genreKey(r.alias), r.canonical);
    }
    for (const r of db
      .query<{ name: string }, []>(`SELECT name FROM library_genres`)
      .all()) {
      const k = genreKey(r.name);
      if (k && !r.name.includes('/')) known.set(k, r.name.trim().replace(/\s+/g, ' '));
    }
  } catch {
    return { aliases, known };
  }
  return { aliases, known };
}

export interface GenreAliasProposal {
  alias: string;
  canonical: string;
  kind: 'junk' | 'variant' | 'concat' | 'slash';
  count: number;
}

// Values that are metadata noise, not genres. Proposed as drops, never applied
// without human review (reclassify-genres.ts --apply).
const JUNK_GENRES = new Set([
  'other',
  'genre',
  'default',
  'unknown',
  'misc',
  'none',
  '<desconocido>',
  'entertainment',
]);

/** Squash key for punctuation/spacing variants: letters+digits only. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Deterministic alias suggestions from the library's post-split genre
 * vocabulary. Human-gated by design: the output is a reviewable list, never
 * auto-applied — segmentation in particular has real false positives
 * ("BritPop") that only vocabulary membership filters out.
 */
export function proposeGenreAliases(
  vocabulary: Array<{ value: string; count: number }>,
): GenreAliasProposal[] {
  const out: GenreAliasProposal[] = [];
  const byKey = new Map(vocabulary.map((v) => [genreKey(v.value), v]));
  const isKnown = (s: string): boolean => byKey.has(genreKey(s));

  // Group punctuation/spacing variants; the most common form is canonical.
  const bySquash = new Map<string, Array<{ value: string; count: number }>>();
  for (const v of vocabulary) {
    const k = squash(v.value);
    if (!k) continue;
    const group = bySquash.get(k) ?? [];
    group.push(v);
    bySquash.set(k, group);
  }

  for (const v of vocabulary) {
    if (JUNK_GENRES.has(genreKey(v.value))) {
      out.push({ alias: v.value, canonical: '', kind: 'junk', count: v.count });
      continue;
    }

    const group = bySquash.get(squash(v.value)) ?? [];
    if (group.length > 1) {
      const canonical = group.reduce((a, b) => (b.count > a.count ? b : a));
      if (canonical.value !== v.value) {
        // A variant of a junk value is itself junk — propose a drop, never a
        // merge onto the junk spelling.
        if (JUNK_GENRES.has(genreKey(canonical.value))) {
          out.push({ alias: v.value, canonical: '', kind: 'junk', count: v.count });
        } else {
          out.push({ alias: v.value, canonical: canonical.value, kind: 'variant', count: v.count });
        }
        continue;
      }
    }

    // Unresolved "/" join: keep only the sides that are real genres.
    if (v.value.includes('/')) {
      const sides = v.value.split('/').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
      const knownSides = sides.filter(isKnown);
      if (sides.length > 1 && knownSides.length > 0 && knownSides.length < sides.length) {
        out.push({
          alias: v.value,
          canonical: knownSides.join(';'),
          kind: 'slash',
          count: v.count,
        });
      }
      continue;
    }

    // No-separator concatenation: split on lowercase→Uppercase boundaries and
    // propose only when EVERY segment is a known genre.
    const segments = v.value.split(/(?<=[a-z])(?=[A-Z])/);
    if (segments.length > 1 && segments.every(isKnown)) {
      out.push({
        alias: v.value,
        canonical: segments.map((s) => s.trim()).join(';'),
        kind: 'concat',
        count: v.count,
      });
    }
  }
  return out;
}
