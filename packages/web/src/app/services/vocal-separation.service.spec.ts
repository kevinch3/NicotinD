import { TestBed } from '@angular/core/testing';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { STEM_POLL_INTERVAL_MS, VocalSeparationService } from './vocal-separation.service';
import { StemApiService } from './api/stem-api.service';
import { PlayerService, type Track } from './player.service';
import { ToastService } from './toast.service';
import type { StemStatus } from './api/api-types';

const T1: Track = { id: 't1', title: 'One', artist: 'A' };
const T2: Track = { id: 't2', title: 'Two', artist: 'A' };

describe('VocalSeparationService', () => {
  let service: VocalSeparationService;
  let player: PlayerService;
  let prepare: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let toast: { show: ReturnType<typeof vi.fn> };
  /** One controllable response per prepare/status call, in call order. */
  let replies: Subject<StemStatus>[];

  const nextReply = () => {
    const s = new Subject<StemStatus>();
    replies.push(s);
    return s.asObservable();
  };
  const reply = (i: number, value: StemStatus) => {
    replies[i].next(value);
    replies[i].complete();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    prepare = vi.fn(() => nextReply());
    status = vi.fn(() => nextReply());
    toast = { show: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        PlayerService,
        { provide: StemApiService, useValue: { prepare, status } },
        { provide: ToastService, useValue: toast },
      ],
    });
    player = TestBed.inject(PlayerService);
    player.clear();
    player.currentTrack.set(T1);
    service = TestBed.inject(VocalSeparationService);
    TestBed.flushEffects();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opening the karaoke overlay prepares the current track', () => {
    expect(prepare).not.toHaveBeenCalled();
    service.setKaraokeOpen(true);
    TestBed.flushEffects();
    expect(prepare).toHaveBeenCalledWith('t1');
  });

  it('muting is intent; the URL only flips to vocals=off once the stem is ready', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    expect(prepare).toHaveBeenCalledWith('t1');
    expect(service.shouldServeVocalsOff('t1')).toBe(false);
    expect(service.vocalMode()).toBe('pending');

    reply(0, { state: 'preparing', etaSec: 40 });
    expect(service.shouldServeVocalsOff('t1')).toBe(false);
    expect(service.etaSec()).toBe(40);

    vi.advanceTimersByTime(STEM_POLL_INTERVAL_MS + 1);
    expect(status).toHaveBeenCalledWith('t1');
    reply(1, { state: 'ready' });
    expect(service.shouldServeVocalsOff('t1')).toBe(true);
    expect(service.currentServeVocalsOff()).toBe(true);
    expect(service.vocalMode()).toBe('ml');
  });

  it('an instance without a separator serves the basic filter at once, for every track', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    reply(0, { state: 'unavailable', reason: 'not-configured' });
    expect(service.shouldServeVocalsOff('t1')).toBe(true);
    expect(service.vocalMode()).toBe('basic');
    // A track never asked about is basic too — ML is known to be absent.
    expect(service.shouldServeVocalsOff('t2')).toBe(true);
  });

  it('a failed separation falls back to basic for that track and says so once', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    reply(0, { state: 'failed', reason: 'transient', retryAfterSec: 30 });
    TestBed.flushEffects();
    expect(service.shouldServeVocalsOff('t1')).toBe(true);
    expect(service.vocalMode()).toBe('basic');
    expect(toast.show).toHaveBeenCalledTimes(1);
    // A track not asked about stays pending-on-ML (the instance does have a separator).
    expect(service.shouldServeVocalsOff('t2')).toBe(false);
  });

  it('while muted, the next queued track is prepared ahead of time', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    reply(0, { state: 'ready' });
    player.queue.set([T2]);
    TestBed.flushEffects();
    expect(prepare).toHaveBeenCalledWith('t2');
  });

  it('the ETA counts down between polls and never reads below one second', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    reply(0, { state: 'queued', queuePosition: 1, etaSec: 3 });
    expect(service.etaSec()).toBe(3);
    expect(service.queuePosition()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(service.etaSec()).toBe(2);
    vi.advanceTimersByTime(5_000);
    expect(service.etaSec()).toBe(1);
  });

  it('polling stops once the karaoke session ends', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    reply(0, { state: 'preparing', etaSec: 40 });
    player.toggleVocalMute(); // unmute: no overlay, no mute → session over
    TestBed.flushEffects();
    vi.advanceTimersByTime(STEM_POLL_INTERVAL_MS * 3);
    expect(status).not.toHaveBeenCalled();
  });

  it('unmuting turns the URL back to the plain mix immediately', () => {
    player.toggleVocalMute();
    TestBed.flushEffects();
    reply(0, { state: 'ready' });
    expect(service.currentServeVocalsOff()).toBe(true);
    player.toggleVocalMute();
    TestBed.flushEffects();
    expect(service.currentServeVocalsOff()).toBe(false);
    expect(service.vocalMode()).toBe('off');
  });

  it('a stale prepare answer for a different track never applies to the current one', () => {
    service.setKaraokeOpen(true);
    TestBed.flushEffects();
    player.currentTrack.set(T2);
    TestBed.flushEffects();
    reply(0, { state: 'ready' }); // t1's answer
    expect(service.shouldServeVocalsOff('t1')).toBe(false); // not muted
    player.toggleVocalMute();
    TestBed.flushEffects();
    expect(service.shouldServeVocalsOff('t2')).toBe(false); // t2 has its own state
    expect(service.shouldServeVocalsOff('t1')).toBe(true);
  });
});
