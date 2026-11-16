import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type {
  LyricsApplied,
  LyricsCandidate,
  LyricsDto,
  LyricsPassedOver,
  LyricsQuery,
} from '@nicotind/core';
import { LYRICS_DURATION_TOLERANCE_SEC } from '@nicotind/core';
import { writeAudioTags } from './audio-tags.js';
import { choiceFor, isOtherTake, sameLrc } from './lyrics-fetch.js';
import { getLyrics, getLyricsChoice, setLyrics } from './lyrics-store.js';
import type { PluginRegistry } from './plugins/registry.js';
import { expandDir, isUnderMusicDir, resolveSongPath } from './song-path.js';
import { streamActivity, type StreamActivity } from './stream-activity.js';

/** A candidate after the host's gate, de-duplication and ranking. */
export interface RankedLyricsCandidate extends LyricsCandidate {
  /** The source stated a duration and it is within the tolerance of the song's. */
  verified: boolean;
  /** `matchedDurationSec − song duration`, null when either is unknown. */
  durationDeltaSec: number | null;
  /** Other records carrying the same text, folded into this one. */
  duplicates: number;
}

export type LyricsNextOutcome =
  | { kind: 'applied'; lyrics: LyricsDto; applied: LyricsApplied }
  /** The stored words are the only candidate; the row is unchanged. */
  | { kind: 'only-one'; lyrics: LyricsDto; applied: LyricsApplied }
  | { kind: 'no-match'; lyrics: LyricsDto | null }
  /** A user-edited row, without `confirmReplaceEdit`; the row is unchanged. */
  | { kind: 'customized'; lyrics: LyricsDto }
  | { kind: 'song-not-found' }
  | { kind: 'no-source' }
  | { kind: 'source-error' };

const normText = (t: string | null | undefined) => (t ?? '').replace(/\r\n?/g, '\n').trim();

/** What two candidates must share to count as the same lyrics. */
function textIdentity(c: { plain: string | null; synced: string | null }): string {
  return c.synced ? `synced:${normText(c.synced)}` : `plain:${normText(c.plain)}`;
}

/**
 * Every lyrics record the enabled sources offer for a song, as one ranked list
 * (docs/lyrics-options.md §1). The rules are the host's, whatever a source says:
 *
 * - **Duration gate (#1212):** a candidate whose stated duration is beyond
 *   `LYRICS_DURATION_TOLERANCE_SEC` of the song's is dropped. One with no
 *   duration stays, unverified.
 * - **Ranking:** timed first, verified first, smaller duration delta, then the
 *   registry's source order.
 * - **De-duplication:** candidates with the same normalized text count as one;
 *   the best-ranked is kept and the copies are counted.
 */
export async function listLyricsCandidates(
  plugins: PluginRegistry,
  query: LyricsQuery,
): Promise<{ candidates: RankedLyricsCandidate[]; errored: boolean }> {
  const local = query.durationSec && query.durationSec > 0 ? query.durationSec : null;
  let errored = false;
  const gathered: Array<{ c: RankedLyricsCandidate; order: number }> = [];
  let order = 0;
  for (const plugin of plugins.getEnabledWithCapability('lyrics')) {
    const cap = plugin.lyrics;
    if (!cap) continue;
    let list: LyricsCandidate[] = [];
    try {
      if (cap.fetchCandidates) {
        list = await cap.fetchCandidates(query);
      } else {
        const one = await cap.fetchLyrics(query);
        if (one) list = [{ ...one, candidateKey: one.sourceTrackId ?? hashKey(one) }];
      }
    } catch {
      errored = true;
    }
    for (const c of list) {
      if (!normText(c.plain) && !normText(c.synced)) continue;
      const matched = typeof c.matchedDurationSec === 'number' ? c.matchedDurationSec : null;
      const delta = matched != null && local != null ? matched - local : null;
      if (delta != null && Math.abs(delta) > LYRICS_DURATION_TOLERANCE_SEC) continue;
      gathered.push({
        c: {
          ...c,
          synced: normText(c.synced) ? c.synced : null,
          plain: normText(c.plain) ? c.plain : null,
          verified: delta != null,
          durationDeltaSec: delta,
          duplicates: 0,
        },
        order: order++,
      });
    }
  }
  gathered.sort(
    (a, b) =>
      Number(!!b.c.synced) - Number(!!a.c.synced) ||
      Number(b.c.verified) - Number(a.c.verified) ||
      Math.abs(a.c.durationDeltaSec ?? 0) - Math.abs(b.c.durationDeltaSec ?? 0) ||
      a.order - b.order,
  );
  const byText = new Map<string, RankedLyricsCandidate>();
  for (const { c } of gathered) {
    const kept = byText.get(textIdentity(c));
    if (kept) kept.duplicates += 1;
    else byText.set(textIdentity(c), c);
  }
  return { candidates: [...byText.values()], errored };
}

function hashKey(c: { plain: string | null; synced: string | null }): string {
  return `text:${createHash('sha1').update(textIdentity(c)).digest('hex').slice(0, 16)}`;
}

const appliedOf = (c: RankedLyricsCandidate, index: number, total: number): LyricsApplied => ({
  source: c.source,
  sourceTrackId: c.sourceTrackId ?? null,
  candidateKey: c.candidateKey,
  index,
  total,
  timed: !!c.synced,
});

/**
 * "Try another source" (#1674): apply the candidate after the stored one,
 * wrapping at the end. Stateless: the cursor is the stored row itself, matched
 * to a candidate by the key recorded in its `LyricsChoice`, else by its text.
 * A row that matches no candidate (a file-tag row, a user edit, a record the
 * source dropped) gets the first.
 *
 * - **Never a downgrade (#1672):** a timed row that is not another take walks
 *   timed candidates only.
 * - **Never an edit unasked (#1786):** a `customized` row answers `customized`
 *   without `confirmReplaceEdit`.
 * - **The offset survives the same text (#1785).**
 * - `only-one` and `no-match` leave the row unchanged.
 */
export async function nextSongLyrics(
  db: Database,
  deps: { plugins?: PluginRegistry | null; musicDir?: string; activity?: StreamActivity },
  songId: string,
  opts: { confirmReplaceEdit?: boolean } = {},
): Promise<LyricsNextOutcome> {
  const song = db
    .query<
      { path: string; title: string; artist: string; duration: number; album: string | null },
      [string]
    >(
      `SELECT s.path, s.title, s.artist, s.duration, a.name AS album
       FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
       WHERE s.id = ?`,
    )
    .get(songId);
  if (!song) return { kind: 'song-not-found' };

  const existing = getLyrics(db, songId);
  if (existing?.customized && !opts.confirmReplaceEdit) {
    return { kind: 'customized', lyrics: existing };
  }
  if (!deps.plugins?.hasCapability('lyrics')) return { kind: 'no-source' };

  const { candidates, errored } = await listLyricsCandidates(deps.plugins, {
    title: song.title,
    artist: song.artist,
    album: song.album ?? undefined,
    durationSec: song.duration || undefined,
  });
  const otherTake = isOtherTake(existing, song.duration);
  const timedOnly = !!existing?.synced && !otherTake;
  const walk = timedOnly ? candidates.filter((c) => c.synced) : candidates;
  if (walk.length === 0) {
    return errored ? { kind: 'source-error' } : { kind: 'no-match', lyrics: existing };
  }

  // A user's edit is no candidate's text, and its recorded choice names the
  // record it started from, so an edited row always restarts at the first.
  const storedKey = existing && !existing.customized ? getLyricsChoice(db, songId) : null;
  let at = -1;
  if (existing && !existing.customized) {
    at = walk.findIndex(
      (c) => c.source === storedKey?.source && c.candidateKey === storedKey?.candidateKey,
    );
    if (at < 0) at = walk.findIndex((c) => textIdentity(c) === textIdentity(existing));
  }
  if (at >= 0 && walk.length === 1) {
    return { kind: 'only-one', lyrics: existing!, applied: appliedOf(walk[0]!, 1, 1) };
  }

  const index = (at + 1) % walk.length;
  const next = walk[index]!;
  const passedOver: LyricsPassedOver[] = walk
    .slice(0, index)
    .slice(0, 5)
    .map((c) => ({
      source: c.source,
      candidateKey: c.candidateKey,
      timed: !!c.synced,
      durationDeltaSec: c.durationDeltaSec,
    }));
  const saved = setLyrics(db, songId, {
    plain: next.plain,
    synced: next.synced,
    source: next.source,
    customized: false,
    // What "Undo last change" puts back (#1960).
    snapshot: !!existing,
    matchedDurationSec: next.matchedDurationSec ?? null,
    sourceTrackId: next.sourceTrackId ?? null,
    ...(existing?.synced && next.synced && sameLrc(existing.synced, next.synced)
      ? { offsetMs: existing.offsetMs }
      : {}),
    choice: {
      ...choiceFor(next, song.duration, {
        skippedUntimed: [],
        replacedOtherTake: otherTake,
        forced: true,
      }),
      candidateKey: next.candidateKey,
      index: index + 1,
      total: walk.length,
      duplicates: next.duplicates,
      via: 'next',
      passedOver,
    },
  });

  // Only changed words reach the file, and only once nobody is streaming it.
  const md = deps.musicDir ? expandDir(deps.musicDir) : null;
  const abs = md ? resolveSongPath(md, song.path) : null;
  if (
    next.plain &&
    normText(next.plain) !== normText(existing?.plain) &&
    md !== null &&
    abs !== null &&
    isUnderMusicDir(md, abs) &&
    existsSync(abs)
  ) {
    const plain = next.plain;
    (deps.activity ?? streamActivity).writeWhenIdle(abs, () =>
      writeAudioTags(abs, { lyrics: plain }),
    );
  }
  return { kind: 'applied', lyrics: saved, applied: appliedOf(next, index + 1, walk.length) };
}
