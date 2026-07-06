/**
 * Which indicator a track row shows for the *current* track: spinner while
 * audio buffers (HDD loads take seconds), equalizer bars while playing,
 * static bars while paused; null for every non-current row. DI-free so it's
 * testable without the component (the web JIT harness can't drive input()
 * signals).
 */
export type RowPlaybackState = 'buffering' | 'playing' | 'paused';

export function rowPlaybackState(
  currentTrackId: string | undefined,
  rowTrackId: string,
  bufferingVisible: boolean,
  isPlaying: boolean,
): RowPlaybackState | null {
  if (!currentTrackId || currentTrackId !== rowTrackId) return null;
  if (bufferingVisible) return 'buffering';
  return isPlaying ? 'playing' : 'paused';
}
