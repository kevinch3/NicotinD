import { rowPlaybackState } from './row-playback-state';

describe('rowPlaybackState', () => {
  it('is null when the row is not the current track', () => {
    expect(rowPlaybackState(undefined, 't1', false, false)).toBeNull();
    expect(rowPlaybackState('other', 't1', true, true)).toBeNull();
  });

  it('reports buffering ahead of playing (spinner wins while loading)', () => {
    expect(rowPlaybackState('t1', 't1', true, true)).toBe('buffering');
  });

  it('reports playing / paused from isPlaying once buffering settles', () => {
    expect(rowPlaybackState('t1', 't1', false, true)).toBe('playing');
    expect(rowPlaybackState('t1', 't1', false, false)).toBe('paused');
  });
});
