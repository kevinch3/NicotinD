/**
 * Display-safe cleanup of YouTube-sourced title pollution ("Pegao (Official
 * Video)", "(Audio Oficial)", "[Lyric Video]" …) and reissue labels
 * ("- Remastered 2009"). Deliberately conservative:
 * a bracketed segment or trailing "- X" / "| X" tail is removed only when
 * EVERY word in it belongs to the junk vocabulary — "(Remix)", "(En Vivo)",
 * "(feat. X)" and even mixed segments like "(Official Video Remix)" survive.
 *
 * Not to be confused with `stripTitleQualifiers` (@nicotind/core), which
 * strips ALL bracketed groups — correct for search-query fan-out, destructive
 * for display titles. Issue #722.
 */

import { fold } from '@nicotind/core';

export interface CleanTitleResult {
  cleaned: string;
  /** Original text of each removed segment, brackets/separator included. */
  removed: string[];
}

// A segment is junk when all its words are CORE ∪ MODIFIER and ≥1 is CORE.
// CORE words name the video-platform artifact itself; MODIFIER words only
// qualify one ("Official", "Music") and never make a segment junk alone.
const CORE_JUNK = new Set([
  'video',
  'audio',
  'visualizer',
  'visualiser',
  'lyric',
  'lyrics',
  'letra',
  'videoclip',
  'hd',
  'hq',
  '4k',
  '1080p',
  '720p',
  // Remaster labels name a reissue artifact, not the recording (issue #775).
  // `remasterd` is the apostrophe-stripped form of "Remaster'd".
  'remaster',
  'remastered',
  'remasterd',
  'remastering',
]);
// `version` / `edition` only ever qualify a CORE word — "(Deluxe Edition)" and
// "(Live Version)" survive untouched because `deluxe` / `live` are not junk.
const MODIFIER_JUNK = new Set(['official', 'oficial', 'music', 'full', 'version', 'edition']);

// A four-digit year qualifies a remaster ("Remastered 2009") but never makes a
// segment junk by itself — "(1999)" and "- 2003" are left alone.
const YEAR = /^(?:19|20)\d{2}$/;

function isJunkSegment(content: string): boolean {
  const tokens = fold(content)
    // Drop apostrophes before splitting so "Remaster'd" is one token rather
    // than `remaster` + a bare `d` (which would need `d` in the vocabulary).
    .replace(/['\u2019]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let hasCore = false;
  for (const token of tokens) {
    if (CORE_JUNK.has(token)) hasCore = true;
    else if (!MODIFIER_JUNK.has(token) && !YEAR.test(token)) return false;
  }
  return hasCore;
}

export function cleanDisplayTitle(raw: string): CleanTitleResult {
  const removed: string[] = [];

  let out = raw.replace(/[([{][^()[\]{}]*[)\]}]/g, (segment) => {
    if (!isJunkSegment(segment.slice(1, -1))) return segment;
    removed.push(segment);
    return ' ';
  });

  for (;;) {
    const tail = out.match(/\s+([|\-–—])\s+([^|\-–—]+?)\s*$/);
    if (!tail || !isJunkSegment(tail[2])) break;
    removed.push(`${tail[1]} ${tail[2].trim()}`);
    out = out.slice(0, out.length - tail[0].length);
  }

  if (removed.length === 0) return { cleaned: raw, removed: [] };
  const cleaned = out.replace(/\s+/g, ' ').trim();
  // Never hand back an empty title: an all-junk input stays as it was.
  if (!cleaned) return { cleaned: raw, removed: [] };
  return { cleaned, removed };
}
