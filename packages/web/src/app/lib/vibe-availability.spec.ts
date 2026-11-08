import { describe, expect, it } from 'vitest';
import { of, throwError } from 'rxjs';
import type { LibraryFilter } from '@nicotind/core';
import { playableVibes } from './vibe-availability';
import { VIBE_PRESETS } from './vibe-presets';

const song = { id: 's1' };

describe('playableVibes (#1739)', () => {
  it('keeps only the vibes with at least one matching song', async () => {
    // A server with tags but no analysis sidecar: BPM is there, moods are not.
    const probe = (_size: number, _offset: number, opts: { filter?: LibraryFilter }) =>
      of(opts.filter?.bpmMin ? [song] : []);
    const vibes = await playableVibes({ getAllSongs: probe as never });
    expect(vibes.map((v) => v.id)).toEqual(['fast']);
  });

  it('keeps a vibe whose probe failed, so a flaky request does not hide it', async () => {
    const probe = () => throwError(() => new Error('500'));
    const vibes = await playableVibes({ getAllSongs: probe as never });
    expect(vibes).toHaveLength(VIBE_PRESETS.length);
  });

  it('asks for one song per vibe, not a page', async () => {
    const sizes: number[] = [];
    const probe = (size: number) => {
      sizes.push(size);
      return of([song]);
    };
    await playableVibes({ getAllSongs: probe as never });
    expect(new Set(sizes)).toEqual(new Set([1]));
  });
});
