import { describe, it, expect } from 'vitest';
import { compareDiscThenTrack, discGroups } from './disc-order';

/**
 * Issue #747. Album identity collapses discs into one album, so on a two-disc
 * release "Track #" means (disc, track). Sorting on `track` alone interleaves
 * the discs — 1, 1, 2, 2 — and shows two rows both labelled "1".
 */
describe('compareDiscThenTrack', () => {
  const s = (disc: number | undefined, track: number | undefined, id = `${disc}-${track}`) => ({
    id,
    disc,
    track,
  });

  it('orders by disc before track', () => {
    const sorted = [s(2, 1), s(1, 2), s(1, 1), s(2, 2)].sort(compareDiscThenTrack);
    expect(sorted.map((x) => x.id)).toEqual(['1-1', '1-2', '2-1', '2-2']);
  });

  it('treats a missing disc as disc 1 rather than sorting it first', () => {
    const sorted = [s(2, 1), s(undefined, 5, 'untagged')].sort(compareDiscThenTrack);
    expect(sorted.map((x) => x.id)).toEqual(['untagged', '2-1']);
  });

  it('puts a missing track last within its disc, matching the server', () => {
    // The route orders `s.track ASC NULLS LAST`; the client must not disagree.
    const sorted = [s(1, undefined, 'no-track'), s(1, 9)].sort(compareDiscThenTrack);
    expect(sorted.map((x) => x.id)).toEqual(['1-9', 'no-track']);
  });

  it('is a no-op ordering for a single-disc album', () => {
    const sorted = [s(undefined, 1, 'a'), s(undefined, 2, 'b'), s(undefined, 3, 'c')].sort(
      compareDiscThenTrack,
    );
    expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('discGroups', () => {
  it('returns no groups for a single-disc album, so nothing renders', () => {
    // Headers on a one-disc album would be noise on every existing album.
    expect(
      discGroups([
        { id: 'a', track: 1 },
        { id: 'b', track: 2 },
      ]),
    ).toEqual([]);
    expect(discGroups([{ id: 'a', disc: 1, track: 1 }])).toEqual([]);
  });

  it('groups by disc once an album genuinely has more than one', () => {
    const groups = discGroups([
      { id: 'a', disc: 1, track: 1 },
      { id: 'b', disc: 1, track: 2 },
      { id: 'c', disc: 2, track: 1 },
    ]);
    expect(groups.map((g) => g.disc)).toEqual([1, 2]);
    expect(groups.map((g) => g.songs.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('groups an untagged track under disc 1 alongside its tagged siblings', () => {
    const groups = discGroups([
      { id: 'untagged', track: 1 },
      { id: 'tagged', disc: 1, track: 2 },
      { id: 'second', disc: 2, track: 1 },
    ]);
    expect(groups.map((g) => g.disc)).toEqual([1, 2]);
    expect(groups[0]!.songs.map((s) => s.id)).toEqual(['untagged', 'tagged']);
  });
});
