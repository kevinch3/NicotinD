import { TestBed } from '@angular/core/testing';
import { PlayerService, type Track, type PlayContext } from './player.service';

const track1: Track = { id: 't1', title: 'Track 1', artist: 'Artist A' };
const track2: Track = { id: 't2', title: 'Track 2', artist: 'Artist B' };
const track3: Track = { id: 't3', title: 'Track 3', artist: 'Artist C' };

describe('PlayerService', () => {
  let service: PlayerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PlayerService);
    // Reset to initial state
    service.clear();
    service.repeat.set('off');
    service.shuffle.set(false);
  });

  describe('play(track)', () => {
    it('sets currentTrack and isPlaying = true', () => {
      service.play(track1);
      expect(service.currentTrack()).toEqual(track1);
      expect(service.isPlaying()).toBe(true);
    });
  });

  describe('pause()', () => {
    it('sets isPlaying = false without clearing currentTrack', () => {
      service.play(track1);
      service.pause();
      expect(service.isPlaying()).toBe(false);
      expect(service.currentTrack()).toEqual(track1);
    });
  });

  describe('resume()', () => {
    it('sets isPlaying = true without affecting track or queue', () => {
      service.play(track1);
      service.queue.set([track2]);
      service.pause();
      service.resume();
      expect(service.isPlaying()).toBe(true);
      expect(service.currentTrack()).toEqual(track1);
      expect(service.queue()).toEqual([track2]);
    });
  });

  describe('setCurrentTrackMetadata(track)', () => {
    it('sets currentTrack but does NOT set isPlaying = true', () => {
      service.setCurrentTrackMetadata(track1);
      expect(service.currentTrack()).toEqual(track1);
      expect(service.isPlaying()).toBe(false);
    });

    it('does not start playback when called while paused', () => {
      service.play(track1);
      service.pause();
      const updatedTrack: Track = { ...track1, title: 'Updated Title' };
      service.setCurrentTrackMetadata(updatedTrack);
      expect(service.isPlaying()).toBe(false);
    });
  });

  describe('playNext()', () => {
    it('with empty queue and repeat = "off" keeps the last track loaded but paused', () => {
      // Clearing the track would hide the mini-player (and, on mobile, the user
      // would have to start playback again just to get the player chrome back)
      // and wipe the persisted session.
      service.play(track1);
      service.queue.set([]);
      service.repeat.set('off');
      service.playNext();
      expect(service.currentTrack()).toEqual(track1);
      expect(service.isPlaying()).toBe(false);
      // The track is still current, so it must not also move into history.
      expect(service.history()).toEqual([]);
    });

    it('with repeat = "all" and a context reloads from context.originalOrder', () => {
      const context: PlayContext = {
        type: 'album',
        id: 'album-1',
        name: 'Test Album',
        originalOrder: [track1, track2, track3],
      };
      service.play(track3);
      service.queue.set([]);
      service.repeat.set('all');
      service.shuffle.set(false);
      service.context.set(context);
      service.playNext();
      // Should reload from originalOrder: first track becomes current, rest go to queue
      expect(service.currentTrack()).toEqual(track1);
      expect(service.isPlaying()).toBe(true);
      expect(service.queue()).toEqual([track2, track3]);
      expect(service.history()).toEqual([]);
    });

    it('with non-empty queue plays the next track in queue', () => {
      service.play(track1);
      service.queue.set([track2, track3]);
      service.repeat.set('off');
      service.playNext();
      expect(service.currentTrack()).toEqual(track2);
      expect(service.queue()).toEqual([track3]);
      expect(service.isPlaying()).toBe(true);
    });
  });

  describe('playPrev()', () => {
    it('with non-empty history moves the last history item to currentTrack', () => {
      service.play(track3);
      service.history.set([track1, track2]);
      service.queue.set([]);
      service.playPrev();
      expect(service.currentTrack()).toEqual(track2);
      expect(service.isPlaying()).toBe(true);
      expect(service.history()).toEqual([track1]);
      // current track (track3) should be pushed to the front of the queue
      expect(service.queue()).toEqual([track3]);
    });

    it('with empty history is a no-op', () => {
      service.play(track1);
      service.history.set([]);
      service.playPrev();
      expect(service.currentTrack()).toEqual(track1);
      expect(service.history()).toEqual([]);
    });
  });

  describe('state persistence', () => {
    const STORAGE_KEY = 'nicotind_player_state';

    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('writes currentTrack to localStorage when play() is called', () => {
      service.play(track1);
      TestBed.flushEffects();
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(state.currentTrack).toEqual(track1);
    });

    it('writes queue to localStorage when queue changes', () => {
      service.play(track1);
      service.queue.set([track2, track3]);
      TestBed.flushEffects();
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(state.queue).toEqual([track2, track3]);
    });

    it('writes shuffle and repeat to localStorage', () => {
      service.play(track1);
      service.shuffle.set(true);
      service.repeat.set('all');
      TestBed.flushEffects();
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(state.shuffle).toBe(true);
      expect(state.repeat).toBe('all');
    });

    it('removes localStorage entry when currentTrack is null', () => {
      service.play(track1);
      TestBed.flushEffects();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      service.currentTrack.set(null);
      TestBed.flushEffects();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('restoreState() restores currentTrack, queue, history, shuffle, repeat, context', () => {
      const ctx: PlayContext = {
        type: 'album',
        id: 'album-1',
        name: 'Test Album',
        originalOrder: [track1, track2],
      };
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          currentTrack: track1,
          queue: [track2],
          history: [track3],
          shuffle: true,
          repeat: 'all',
          context: ctx,
          currentTime: 30,
        }),
      );
      service.restoreState();
      expect(service.currentTrack()).toEqual(track1);
      expect(service.queue()).toEqual([track2]);
      expect(service.history()).toEqual([track3]);
      expect(service.shuffle()).toBe(true);
      expect(service.repeat()).toBe('all');
      expect(service.context()).toEqual(ctx);
    });

    it('restoreState() always leaves isPlaying = false', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          currentTrack: track1,
          queue: [],
          history: [],
          shuffle: false,
          repeat: 'off',
          context: null,
          currentTime: 5,
        }),
      );
      service.restoreState();
      expect(service.isPlaying()).toBe(false);
    });

    it('restoreState() sets restoredTime when currentTime > 1', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          currentTrack: track1,
          queue: [],
          history: [],
          shuffle: false,
          repeat: 'off',
          context: null,
          currentTime: 45.5,
        }),
      );
      service.restoreState();
      expect(service.restoredTime).toBe(45.5);
    });

    it('restoreState() leaves restoredTime null when currentTime <= 1', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          currentTrack: track1,
          queue: [],
          history: [],
          shuffle: false,
          repeat: 'off',
          context: null,
          currentTime: 0.5,
        }),
      );
      service.restoreState();
      expect(service.restoredTime).toBeNull();
    });

    it('restoreState() is a no-op when localStorage is empty', () => {
      service.restoreState();
      expect(service.currentTrack()).toBeNull();
      expect(service.queue()).toEqual([]);
      expect(service.isPlaying()).toBe(false);
    });

    it('restoreState() clears corrupt localStorage without throwing', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json{{{');
      expect(() => service.restoreState()).not.toThrow();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clear() removes the localStorage entry synchronously', () => {
      service.play(track1);
      TestBed.flushEffects();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      service.clear();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('persists the radio flag to localStorage', () => {
      service.play(track1);
      service.radio.set(true);
      TestBed.flushEffects();
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).radio).toBe(true);
    });

    it('restoreState() restores the radio flag', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ currentTrack: track1, radio: true }));
      service.restoreState();
      expect(service.radio()).toBe(true);
    });
  });

  describe('radio', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('toggleRadio flips the flag', () => {
      expect(service.radio()).toBe(false);
      service.toggleRadio();
      expect(service.radio()).toBe(true);
      service.toggleRadio();
      expect(service.radio()).toBe(false);
    });

    it('fills the queue immediately when toggled on with a low queue', async () => {
      service.setRadioProvider(async () => [track2, track3, track1]); // t1 = current, filtered
      service.play(track1);
      service.queue.set([]);

      service.toggleRadio();
      await flush();

      expect(service.queue().map((t) => t.id)).toEqual(['t2', 't3']);
    });

    it('auto-replenishes when the queue drains while radio is on', async () => {
      service.setRadioProvider(async () => [track2, track3]);
      service.play(track1);
      service.radio.set(true);
      service.queue.set([]); // drained → effect fires
      TestBed.flushEffects();
      await flush();

      expect(service.queue().length).toBeGreaterThan(0);
    });

    it('does not replenish when radio is off', async () => {
      let calls = 0;
      service.setRadioProvider(async () => {
        calls++;
        return [track2];
      });
      service.play(track1);
      service.queue.set([]);
      TestBed.flushEffects();
      await flush();

      expect(calls).toBe(0);
    });

    it('does not replenish while repeating', async () => {
      let calls = 0;
      service.setRadioProvider(async () => {
        calls++;
        return [track2];
      });
      service.play(track1);
      service.radio.set(true);
      service.repeat.set('all');
      service.queue.set([]);
      TestBed.flushEffects();
      await flush();

      expect(calls).toBe(0);
    });
  });
});
