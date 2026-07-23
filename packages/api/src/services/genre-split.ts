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
    // Ascending song_count so on a pre-migration table still holding casing
    // duplicates ("Latin" + "latin") the most common spelling wins the display
    // slot; post-migration tables have one row per key and this is a no-op.
    for (const r of db
      .query<{ name: string }, []>(`SELECT name FROM library_genres ORDER BY song_count ASC`)
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

/** Shortest segment a concatenation split may produce — blocks "RnB" → Rn + B. */
const MIN_SEGMENT = 3;

/**
 * Segment a no-separator genre concatenation ("LatinWorld",
 * "Tech-HouseDowntempoTechno") into its constituent genres, or null when it
 * can't be covered entirely by known genres.
 *
 * Two rules keep this safe enough to *propose* (it is still human-gated):
 *
 * - **Cuts only at an uppercase letter directly preceded by a letter or digit.**
 *   That is what a mash looks like ("...WorldCountry"), and it is what stops real
 *   compound genres from being torn apart at their own separator: "Pop Rock"
 *   (781 songs in the real library), "Dance-Pop" (433) and "Singer-Songwriter"
 *   (237) have no legal cut and can never be split.
 * - **Every segment must resolve to a known genre**, all-or-nothing, mirroring the
 *   existing `/`-split rule. `resolveKnown` matches punctuation/space-insensitively
 *   and returns the *vocabulary* spelling, so a `Tech-House` tag lands on the
 *   library's `Tech House`.
 *
 * Longest segment first (with backtracking) so multi-word genres win over their
 * own prefixes: "…Soft RockElectronic…" yields "Soft Rock", not "Soft" + …
 */
export function segmentConcatenatedGenre(
  value: string,
  resolveKnown: (s: string) => string | null,
): string[] | null {
  const v = norm(value);
  if (v.length < MIN_SEGMENT * 2) return null;

  // Legal cut positions: index i splits [0,i) / [i,…) when v[i] is uppercase and
  // v[i-1] is alphanumeric (so a space or a hyphen protects the compound).
  const cuts: number[] = [];
  for (let i = 1; i < v.length; i++) {
    if (/\p{Lu}/u.test(v[i]!) && /[\p{L}\p{N}]/u.test(v[i - 1]!)) cuts.push(i);
  }
  if (cuts.length === 0) return null;

  const ends = [...cuts, v.length];
  const memo = new Map<number, string[] | null>();
  const solve = (start: number): string[] | null => {
    if (start === v.length) return [];
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    memo.set(start, null); // cycle guard (unreachable — ends strictly increase)
    // Longest candidate segment first.
    for (let i = ends.length - 1; i >= 0; i--) {
      const end = ends[i]!;
      if (end <= start) continue;
      // The whole value is trivially "known" (it is in the vocabulary itself) —
      // a one-segment cover is not a split.
      if (start === 0 && end === v.length) continue;
      const piece = v.slice(start, end).trim();
      if (piece.length < MIN_SEGMENT) continue;
      const canonical = resolveKnown(piece);
      if (!canonical) continue;
      const rest = solve(end);
      if (rest) {
        const out = [canonical, ...rest];
        memo.set(start, out);
        return out;
      }
    }
    memo.set(start, null);
    return null;
  };

  const segments = solve(0);
  if (!segments || segments.length < 2) return null;

  // Collapse duplicates ("LatinPopLatin Pop" → one "Latin Pop"); a cover that
  // reduces to the input itself is not a split.
  const seen = new Set<string>();
  const unique = segments.filter((s) => {
    const k = genreKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 1 && genreKey(unique[0]!) === genreKey(v)) return null;
  return unique;
}

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
  // Punctuation/space-insensitive resolver for the concatenation splitter: a
  // "Tech-House" fragment must find the library's "Tech House". Longer names win
  // a squash collision so the more specific spelling is what gets emitted.
  // Punctuation/space collisions ("Tech-House" vs "Tech House") resolve to the
  // most common spelling, same canonicalization rule as the `variant` kind.
  const knownBySquash = new Map<string, { value: string; count: number }>();
  for (const v of vocabulary) {
    const k = squash(v.value);
    if (!k || v.value.includes('/')) continue;
    const cur = knownBySquash.get(k);
    if (cur === undefined || v.count > cur.count) knownBySquash.set(k, v);
  }
  const resolveKnown = (s: string): string | null => knownBySquash.get(squash(s))?.value ?? null;

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

    // No-separator concatenation — see segmentConcatenatedGenre for the rules.
    const segments = segmentConcatenatedGenre(v.value, resolveKnown);
    if (segments) {
      out.push({
        alias: v.value,
        canonical: segments.join(';'),
        kind: 'concat',
        count: v.count,
      });
    }
  }
  return out;
}

/** Batch-load full genre sets (primary-first) for a set of song ids. */
export function loadGenreSets(db: Database, songIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (songIds.length === 0) return map;
  const CHUNK = 400; // stay under SQLite's bound-parameter limit
  for (let i = 0; i < songIds.length; i += CHUNK) {
    const chunk = songIds.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(', ');
    const rows = db
      .query<{ song_id: string; genre: string }, string[]>(
        `SELECT song_id, genre FROM library_song_genres
         WHERE song_id IN (${marks}) ORDER BY song_id, position`,
      )
      .all(...chunk);
    for (const r of rows) {
      const list = map.get(r.song_id) ?? [];
      list.push(r.genre);
      map.set(r.song_id, list);
    }
  }
  return map;
}

/**
 * Replace one song's genre set outside a scan (enrichment fill, admin edit):
 * join rows + the mirrored primary column, plus a library_genres count refresh
 * for the touched names so search/grouping reflect the change immediately.
 * The next full scan rebuilds the aggregate wholesale anyway.
 */
/**
 * Append genres to a song's existing set (track-info "detect genre", enrichment,
 * backfill) instead of replacing it. The existing set is kept first — so the current
 * primary (position 0) is preserved — and only genuinely new names are added, deduped
 * case-insensitively. Returns the merged, ordered list so callers can mirror it into
 * the file tag (else the next full scan, which rebuilds from tags, would drop the
 * appended genres). Appending onto an empty set is exactly {@link setSongGenres}.
 */
export function appendSongGenres(db: Database, songId: string, newGenres: string[]): string[] {
  const existing = loadGenreSets(db, [songId]).get(songId) ?? [];
  const seen = new Set(existing.map((g) => g.toLowerCase()));
  const merged = [...existing];
  for (const g of newGenres) {
    const trimmed = g.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  setSongGenres(db, songId, merged);
  return merged;
}

/**
 * Re-apply the (reviewed) alias table to every song's *stored* genre set, so a
 * newly-applied alias takes effect without waiting for a full rescan.
 *
 * This is the one genre write that legitimately **replaces** a primary rather
 * than appending to it — the alias table is human-gated, and re-minting
 * "LatinWorld" → Latin/World is exactly the point. It is also idempotent (a
 * second run finds nothing to change) and rescan-safe: `buildLibrary` applies the
 * same aliases at scan time, so the result survives.
 */
export function backfillGenresFromAliases(db: Database): { scanned: number; updated: number } {
  const ctx = loadGenreContext(db);
  if (ctx.aliases.size === 0) return { scanned: 0, updated: 0 };

  const ids = db
    .query<{ song_id: string }, []>(`SELECT DISTINCT song_id FROM library_song_genres`)
    .all()
    .map((r) => r.song_id);
  const sets = loadGenreSets(db, ids);

  let updated = 0;
  for (const [songId, genres] of sets) {
    // splitGenres over the already-split names re-runs alias expansion (and the
    // `/` rule) on each; joining with ';' keeps multi-word names intact.
    const next = splitGenres(genres.join(';'), ctx);
    if (next.length === genres.length && next.every((g, i) => g === genres[i])) continue;
    setSongGenres(db, songId, next);
    updated++;
  }
  return { scanned: sets.size, updated };
}

export function setSongGenres(db: Database, songId: string, genres: string[]): void {
  const touched = new Set<string>(genres);
  for (const r of db
    .query<{ genre: string }, [string]>(
      `SELECT genre FROM library_song_genres WHERE song_id = ?`,
    )
    .all(songId)) {
    touched.add(r.genre);
  }
  db.transaction(() => {
    db.run(`DELETE FROM library_song_genres WHERE song_id = ?`, [songId]);
    for (let i = 0; i < genres.length; i++) {
      db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, ?)`, [
        songId,
        genres[i]!,
        i,
      ]);
    }
    db.run(`UPDATE library_songs SET genre = ? WHERE id = ?`, [genres[0] ?? null, songId]);
    const now = Date.now();
    for (const name of touched) {
      db.run(
        `INSERT INTO library_genres (name, song_count, album_count, synced_at)
         VALUES (?,
           (SELECT COUNT(*) FROM library_song_genres WHERE genre = ?),
           (SELECT COUNT(DISTINCT s.album_id) FROM library_song_genres sg
             JOIN library_songs s ON s.id = sg.song_id WHERE sg.genre = ?),
           ?)
         ON CONFLICT(name) DO UPDATE SET
           song_count = excluded.song_count,
           album_count = excluded.album_count,
           synced_at = excluded.synced_at`,
        [name, name, name, now],
      );
      db.run(`DELETE FROM library_genres WHERE name = ? AND song_count = 0`, [name]);
    }
  })();
}
