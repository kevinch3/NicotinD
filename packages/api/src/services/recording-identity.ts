/**
 * "Is this the same recording?" — a grouping key for rows that are one track.
 *
 * WHY THIS EXISTS. A song's id is `sha1("song:" + relPath)`
 * (`library-scanner.ts`), so identity *is* the file path. A track you own on
 * its album and on a compilation is two unrelated `library_songs` rows to
 * every consumer, and radio has four of them: the pool sampler dedups on the
 * row id, the `exclude` set is row ids, the per-artist cap counts rows, and
 * the recently-played demotion is keyed on `play_events.song_id`.
 *
 * Measured on prod (issue #660): 363 such groups covering 732 rows — **4.8% of
 * the 15,253 rows radio can serve** — and 361 of the 363 span more than one
 * album. The effect is exactly what two rows in one random draw predicts: a
 * duplicated recording is served **1.99×** as often as a single-file one
 * (0.187 vs 0.094 plays per recording over 1,473 radio plays). Because the
 * demotion never transfers between copies, one recording came back four times
 * in four and a half minutes, alternating between its two files.
 *
 * **Exact duration, deliberately.** The admin `/duplicates` report clusters
 * with a ±2 s tolerance, which it can afford because it greedily clusters the
 * whole library in one in-memory pass. Every consumer here is a *lookup*
 * instead — "has a sibling of this row already been taken/played?" — and a
 * tolerance is not an equivalence relation, so it cannot be a Map key. The
 * 4.8% above was measured under exact equality; widening is a change to make
 * against a measurement, not a hunch.
 *
 * **`null` means "no identity", and never groups with anything.** That is the
 * discipline `repointPlaylistsBeforePrune` states in prose — ambiguity is left
 * to dangle, never guessed — expressed as a return type. Both guards fire on
 * real data: `library_songs.duration` is `NOT NULL DEFAULT 0` and
 * `/songs/:id/similar` applies no duration gate, so un-scanned rows reach that
 * pool; and `normalizeTitle` strips everything outside ASCII `\w\s`, so a
 * CJK-only title reduces to `""` and would otherwise collapse every such track
 * by one artist at one duration into a single recording.
 *
 * Pure and IO-free (peer of `radio.service.ts`); every caller already holds the
 * three fields, so this needs no query and no stored column.
 *
 * See docs/radio.md "Same recording, multiple files".
 */

import { normalizeTitle } from '@nicotind/core';

/**
 * Stable key for "the same recording", or `null` when the row cannot be
 * identified confidently.
 *
 * Takes `artistId` rather than the artist name on purpose: `artistIdFor` is
 * already `sha1("artist:" + normalizeArtistForGrouping(name))`, so it is the
 * normalized artist — interned, and carrying the alias collapse that a fresh
 * string normalization here would miss. Of the 363 duplicate groups measured
 * on prod, zero spanned two artist ids, so it costs nothing in recall.
 *
 * Callers MUST treat `null` as "groups with nothing", including with other
 * nulls.
 */
export function recordingKey(artistId: string, title: string, duration: number): string | null {
  if (!artistId || !Number.isFinite(duration) || duration <= 0) return null;
  const normalized = normalizeTitle(title);
  if (!normalized) return null;
  return `${artistId}|${normalized}|${duration}`;
}
