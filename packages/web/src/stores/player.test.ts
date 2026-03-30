import { describe, it, expect, beforeEach } from 'bun:test';
import { usePlayerStore } from './player';
import type { Track, PlayContext } from './player';

const initialState = {
  currentTrack: null,
  isPlaying: false,
  queue: [],
  history: [],
  shuffle: false,
  repeat: 'off' as const,
  context: null,
  nowPlayingOpen: false,
  currentTime: 0,
  duration: 0,
  seekTo: null,
  autoplayBlocked: false,
};

const track1: Track = { id: 't1', title: 'Track 1', artist: 'Artist A' };
const track2: Track = { id: 't2', title: 'Track 2', artist: 'Artist B' };
const track3: Track = { id: 't3', title: 'Track 3', artist: 'Artist C' };

beforeEach(() => {
  usePlayerStore.setState(initialState);
});

describe('play(track)', () => {
  it('sets currentTrack and isPlaying = true', () => {
    usePlayerStore.getState().play(track1);
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toEqual(track1);
    expect(state.isPlaying).toBe(true);
  });
});

describe('pause()', () => {
  it('sets isPlaying = false without clearing currentTrack', () => {
    usePlayerStore.setState({ currentTrack: track1, isPlaying: true });
    usePlayerStore.getState().pause();
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTrack).toEqual(track1);
  });
});

describe('resume()', () => {
  it('sets isPlaying = true without affecting track or queue', () => {
    usePlayerStore.setState({ currentTrack: track1, isPlaying: false, queue: [track2] });
    usePlayerStore.getState().resume();
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.currentTrack).toEqual(track1);
    expect(state.queue).toEqual([track2]);
  });
});

describe('setCurrentTrackMetadata(track)', () => {
  it('sets currentTrack but does NOT set isPlaying = true', () => {
    usePlayerStore.setState({ currentTrack: null, isPlaying: false });
    usePlayerStore.getState().setCurrentTrackMetadata(track1);
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toEqual(track1);
    expect(state.isPlaying).toBe(false);
  });

  it('does not start playback when called while paused', () => {
    usePlayerStore.setState({ currentTrack: track1, isPlaying: false });
    const updatedTrack: Track = { ...track1, title: 'Updated Title' };
    usePlayerStore.getState().setCurrentTrackMetadata(updatedTrack);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });
});

describe('playNext()', () => {
  it('with empty queue and repeat = "off" clears currentTrack and sets isPlaying = false', () => {
    usePlayerStore.setState({ currentTrack: track1, isPlaying: true, queue: [], repeat: 'off' });
    usePlayerStore.getState().playNext();
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it('with repeat = "all" and a context reloads from context.originalOrder', () => {
    const context: PlayContext = {
      type: 'album',
      id: 'album-1',
      name: 'Test Album',
      originalOrder: [track1, track2, track3],
    };
    usePlayerStore.setState({
      currentTrack: track3,
      isPlaying: true,
      queue: [],
      repeat: 'all',
      shuffle: false,
      context,
    });
    usePlayerStore.getState().playNext();
    const state = usePlayerStore.getState();
    // Should reload from originalOrder: first track becomes current, rest go to queue
    expect(state.currentTrack).toEqual(track1);
    expect(state.isPlaying).toBe(true);
    expect(state.queue).toEqual([track2, track3]);
    expect(state.history).toEqual([]);
  });

  it('with non-empty queue plays the next track in queue', () => {
    usePlayerStore.setState({ currentTrack: track1, isPlaying: true, queue: [track2, track3], repeat: 'off' });
    usePlayerStore.getState().playNext();
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toEqual(track2);
    expect(state.queue).toEqual([track3]);
    expect(state.isPlaying).toBe(true);
  });
});

describe('playPrev()', () => {
  it('with non-empty history moves the last history item to currentTrack', () => {
    usePlayerStore.setState({
      currentTrack: track3,
      isPlaying: true,
      history: [track1, track2],
      queue: [],
    });
    usePlayerStore.getState().playPrev();
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toEqual(track2);
    expect(state.isPlaying).toBe(true);
    expect(state.history).toEqual([track1]);
    // current track (track3) should be pushed to the front of the queue
    expect(state.queue).toEqual([track3]);
  });

  it('with empty history is a no-op', () => {
    usePlayerStore.setState({ currentTrack: track1, isPlaying: true, history: [] });
    usePlayerStore.getState().playPrev();
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toEqual(track1);
    expect(state.history).toEqual([]);
  });
});
