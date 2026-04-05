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
    it('with empty queue and repeat = "off" clears currentTrack and sets isPlaying = false', () => {
      service.play(track1);
      service.queue.set([]);
      service.repeat.set('off');
      service.playNext();
      expect(service.currentTrack()).toBeNull();
      expect(service.isPlaying()).toBe(false);
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
});
