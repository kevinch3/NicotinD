import { describe, expect, it } from 'vitest';
import {
  NO_PREVIEW,
  PREVIEW_COUNT,
  focusSide,
  focusTagKey,
  rotateLead,
  tapIntent,
} from './mosaic-focus';
import type { MosaicTile } from './mosaic-tiles';
import type { Track } from '../services/player.service';

const track: Track = { id: 't1', title: 'Track', artist: 'Artist' };

const tile = (over: Partial<MosaicTile> = {}): MosaicTile => ({
  key: 'song:t1',
  kind: 'song',
  title: 'Track',
  subtitle: 'Artist',
  score: 0.5,
  action: { type: 'song', track },
  ...over,
});

const downloads = tile({
  key: 'downloads',
  kind: 'downloads',
  action: { type: 'route', path: '/library' },
});

describe('tapIntent', () => {
  const SLOP = 6;

  it('a pan is never a tap, whatever it ended on', () => {
    expect(tapIntent(tile(), null, SLOP + 1, SLOP)).toBe('none');
    expect(tapIntent(null, 'song:t1', SLOP + 1, SLOP)).toBe('none');
    expect(tapIntent(downloads, null, SLOP + 1, SLOP)).toBe('none');
  });

  it('a tap on empty space lets a focus go, and is nothing without one', () => {
    expect(tapIntent(null, 'song:t1', 0, SLOP)).toBe('blur');
    expect(tapIntent(null, null, 0, SLOP)).toBe('none');
  });

  it('the downloads shortcut navigates on the first tap', () => {
    expect(tapIntent(downloads, null, 0, SLOP)).toBe('navigate');
    expect(tapIntent(downloads, 'song:t1', 0, SLOP)).toBe('navigate');
  });

  it('every other tile is brought forward, never played', () => {
    expect(tapIntent(tile(), null, 0, SLOP)).toBe('focus');
    expect(tapIntent(tile(), 'song:other', SLOP, SLOP)).toBe('focus');
    expect(tapIntent(tile({ action: { type: 'offline', track } }), null, 0, SLOP)).toBe('focus');
    expect(
      tapIntent(tile({ kind: 'vibe', action: { type: 'filter', filter: {} } }), null, 0, SLOP),
    ).toBe('focus');
  });

  it('another copy of the focused tile is focused in its turn', () => {
    expect(tapIntent(tile(), 'song:t1', 0, SLOP)).toBe('focus');
  });
});

describe('focusSide', () => {
  it('is 60% of the stage, held between 190 and 320, and never crowds a small stage', () => {
    expect(focusSide(390)).toBe(234);
    expect(focusSide(800)).toBe(320);
    expect(focusSide(300)).toBe(190);
    expect(focusSide(200)).toBe(168);
  });
});

describe('focusTagKey', () => {
  it('names the lane a song came from', () => {
    expect(focusTagKey(tile({ lane: 'recent' }))).toBe('mosaic.tag.recent');
    expect(focusTagKey(tile({ lane: 'keepVibe' }))).toBe('mosaic.tag.keepVibe');
    expect(focusTagKey(tile({ lane: 'tasteBreaker' }))).toBe('mosaic.tag.tasteBreaker');
  });

  it('names the kind of a playlist, genre or vibe', () => {
    expect(focusTagKey(tile({ kind: 'playlist' }))).toBe('mosaic.tag.playlist');
    expect(focusTagKey(tile({ kind: 'genre' }))).toBe('mosaic.tag.genre');
    expect(focusTagKey(tile({ kind: 'vibe' }))).toBe('mosaic.tag.vibe');
  });

  it('says nothing for a song of unknown lane, an offline tile or the downloads shortcut', () => {
    expect(focusTagKey(tile())).toBeNull();
    expect(focusTagKey(tile({ lane: 'recent', action: { type: 'offline', track } }))).toBeNull();
    expect(focusTagKey(downloads)).toBeNull();
  });
});

describe('rotateLead', () => {
  it('moves the lead to the back so the next ones lead', () => {
    expect(PREVIEW_COUNT).toBe(3);
    expect(rotateLead([1, 2, 3, 4, 5, 6, 7])).toEqual([4, 5, 6, 7, 1, 2, 3]);
    expect(rotateLead([1, 2, 3, 4])).toEqual([4, 1, 2, 3]);
  });

  it('leaves a list no longer than the lead as it is, and never mutates its input', () => {
    const short = [1, 2, 3];
    expect(rotateLead(short)).toEqual([1, 2, 3]);
    expect(rotateLead([])).toEqual([]);
    const long = [1, 2, 3, 4, 5];
    rotateLead(long);
    expect(long).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('NO_PREVIEW', () => {
  it('is the state of a tile that lists nothing', () => {
    expect(NO_PREVIEW).toEqual({ status: 'none', tracks: [] });
  });
});
