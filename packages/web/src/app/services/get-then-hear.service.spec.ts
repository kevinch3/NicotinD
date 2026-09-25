import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import type { AcquisitionJobView } from '@nicotind/core';
import type { Song } from './api/api-types';
import {
  GET_INTENTS_KEY,
  GET_INTENT_TTL_MS,
  GetThenHearService,
  modeForFileCount,
} from './get-then-hear.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { PlayerService, type Track } from './player.service';
import { ToastService } from './toast.service';
import { TransferService } from './transfer.service';
import { TranslateService } from './translate.service';
import { UserPreferencesService } from './user-preferences.service';

function job(id: string, state: AcquisitionJobView['state']): AcquisitionJobView {
  return { id, state } as AcquisitionJobView;
}

function song(id: string, title = id): Song {
  return { id, title, artist: 'Artist', album: 'Album', albumId: 'al1' } as Song;
}

function track(id: string): Track {
  return { id, title: id, artist: 'Someone' };
}

/** Let the fetch in `land()` resolve. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('GetThenHearService', () => {
  let service: GetThenHearService;
  let player: PlayerService;
  let toast: ToastService;
  let prefs: UserPreferencesService;
  let jobs: ReturnType<typeof signal<AcquisitionJobView[]>>;
  let getJobSongs: ReturnType<typeof vi.fn<(id: string) => Observable<{ songs: Song[] }>>>;

  beforeEach(() => {
    localStorage.clear();
    jobs = signal<AcquisitionJobView[]>([]);
    getJobSongs = vi.fn((_id: string) => of({ songs: [song('s1', 'Landed')] }));
    TestBed.configureTestingModule({
      providers: [
        { provide: DownloadsApiService, useValue: { getJobSongs } },
        { provide: TransferService, useValue: { acquisitionJobs: jobs } },
        {
          provide: TranslateService,
          useValue: {
            t: (key: string, params?: Record<string, unknown>) =>
              params ? `${key} ${JSON.stringify(params)}` : key,
          },
        },
      ],
    });
    service = TestBed.inject(GetThenHearService);
    player = TestBed.inject(PlayerService);
    toast = TestBed.inject(ToastService);
    prefs = TestBed.inject(UserPreferencesService);
  });

  afterEach(() => {
    toast.reset();
    localStorage.clear();
  });

  const stored = () => JSON.parse(localStorage.getItem(GET_INTENTS_KEY) ?? '{}');
  const playing = (...queue: string[]) => {
    player.play(track('current'));
    player.queue.set(queue.map(track));
  };

  describe('mode defaults', () => {
    it('plays a single track next and appends anything bigger', () => {
      expect(modeForFileCount(1)).toBe('next');
      expect(modeForFileCount(2)).toBe('later');
      expect(modeForFileCount(12)).toBe('later');
    });
  });

  describe('remember', () => {
    it('records the intent per device, keyed by job id', () => {
      service.remember('j1', 'next', 1000);
      service.remember('j2', undefined, 2000);
      expect(stored()).toEqual({
        j1: { jobId: 'j1', mode: 'next', at: 1000 },
        j2: { jobId: 'j2', at: 2000 },
      });
    });

    it('records nothing without a job id', () => {
      service.remember(null, 'next');
      service.remember(undefined);
      expect(localStorage.getItem(GET_INTENTS_KEY)).toBeNull();
    });

    it('records nothing when the listener opted out', () => {
      prefs.patch({ queueAcquired: false });
      service.remember('j1', 'next');
      expect(localStorage.getItem(GET_INTENTS_KEY)).toBeNull();
    });
  });

  describe('landing while something plays', () => {
    it('puts a single track next and shows one toast', async () => {
      playing('q1', 'q2');
      service.remember('j1', 'next');
      service.reconcile([job('j1', 'done')]);
      await settle();

      expect(getJobSongs).toHaveBeenCalledWith('j1');
      expect(player.queue().map((t) => t.id)).toEqual(['s1', 'q1', 'q2']);
      expect(player.queue()[0]!.queuedBy).toBe('user');
      expect(player.currentTrack()!.id).toBe('current');
      expect(toast.toasts()).toHaveLength(1);
      expect(toast.toasts()[0]!.message).toContain('getThenHear.queuedNextOne');
      expect(toast.toasts()[0]!.actions!.map((a) => a.label)).toEqual(['getThenHear.playNow']);
    });

    it('appends an album in album order', async () => {
      getJobSongs.mockReturnValue(of({ songs: [song('a1'), song('a2'), song('a3')] }));
      playing('q1');
      service.remember('j1', 'later');
      service.reconcile([job('j1', 'done')]);
      await settle();

      expect(player.queue().map((t) => t.id)).toEqual(['q1', 'a1', 'a2', 'a3']);
      expect(toast.toasts()[0]!.message).toContain('getThenHear.queuedLaterOther');
    });

    it('decides a link by what landed: one track goes next, more go last', async () => {
      playing('q1');
      service.remember('one');
      service.reconcile([job('one', 'done')]);
      await settle();
      expect(player.queue().map((t) => t.id)).toEqual(['s1', 'q1']);

      getJobSongs.mockReturnValue(of({ songs: [song('b1'), song('b2')] }));
      service.remember('many');
      service.reconcile([job('many', 'done')]);
      await settle();
      expect(player.queue().map((t) => t.id)).toEqual(['s1', 'q1', 'b1', 'b2']);
    });

    it('"Play now" jumps to the first landed track wherever it now sits', async () => {
      playing('q1');
      service.remember('j1', 'next');
      service.reconcile([job('j1', 'done')]);
      await settle();
      player.moveInQueue(0, 1); // the listener reordered: [q1, s1]

      toast.toasts()[0]!.actions![0]!.callback();
      expect(player.currentTrack()!.id).toBe('s1');
      expect(toast.toasts()).toHaveLength(0);
    });
  });

  describe('landing on an idle device', () => {
    it('leaves the queue alone and offers Play, which plays the landed set as the queue', async () => {
      getJobSongs.mockReturnValue(of({ songs: [song('a1'), song('a2')] }));
      service.remember('j1', 'later');
      service.reconcile([job('j1', 'done')]);
      await settle();

      expect(player.currentTrack()).toBeNull();
      expect(player.queue()).toEqual([]);
      const t = toast.toasts()[0]!;
      expect(t.message).toContain('getThenHear.readyOther');
      expect(t.actions!.map((a) => a.label)).toEqual(['getThenHear.play']);

      t.actions![0]!.callback();
      expect(player.currentTrack()!.id).toBe('a1');
      expect(player.queue().map((x) => x.id)).toEqual(['a2']);
      expect(player.context()?.type).toBe('adhoc');
    });
  });

  describe('once only', () => {
    it('enqueues a job once however many feed ticks report it done', async () => {
      playing();
      service.remember('j1', 'next');
      service.reconcile([job('j1', 'done')]);
      service.reconcile([job('j1', 'done')]);
      await settle();
      service.reconcile([job('j1', 'done')]);
      await settle();

      expect(getJobSongs).toHaveBeenCalledTimes(1);
      expect(player.queue().map((t) => t.id)).toEqual(['s1']);
      expect(toast.toasts()).toHaveLength(1);
    });

    it('claims the intent before fetching, so a reload mid-fetch cannot replay it', () => {
      service.remember('j1', 'next');
      getJobSongs.mockReturnValue(NEVER);
      service.reconcile([job('j1', 'done')]);
      expect(localStorage.getItem(GET_INTENTS_KEY)).toBeNull();
    });

    it('a failed fetch loses the enqueue rather than retrying into a duplicate', async () => {
      playing();
      getJobSongs.mockReturnValue(throwError(() => new Error('offline')));
      service.remember('j1', 'next');
      service.reconcile([job('j1', 'done')]);
      await settle();
      expect(player.queue()).toEqual([]);
      expect(toast.toasts()).toHaveLength(0);
      expect(localStorage.getItem(GET_INTENTS_KEY)).toBeNull();
    });

    it('follows the job feed once started, and survives an idempotent second start', async () => {
      playing();
      service.start();
      service.start();
      service.remember('j1', 'next');
      jobs.set([job('j1', 'active')]);
      TestBed.tick();
      expect(getJobSongs).not.toHaveBeenCalled();

      jobs.set([job('j1', 'done')]);
      TestBed.tick();
      await settle();
      expect(getJobSongs).toHaveBeenCalledTimes(1);
      expect(player.queue().map((t) => t.id)).toEqual(['s1']);
    });
  });

  describe('nothing to hear', () => {
    it('a failed job produces no toast, no fetch and no queue change', async () => {
      playing('q1');
      service.remember('j1', 'next');
      service.reconcile([job('j1', 'failed')]);
      await settle();
      expect(getJobSongs).not.toHaveBeenCalled();
      expect(player.queue().map((t) => t.id)).toEqual(['q1']);
      expect(toast.toasts()).toHaveLength(0);
      expect(localStorage.getItem(GET_INTENTS_KEY)).toBeNull();
    });

    it('a done job that landed no playable song produces no toast', async () => {
      playing('q1');
      getJobSongs.mockReturnValue(of({ songs: [] }));
      service.remember('j1', 'next');
      service.reconcile([job('j1', 'done')]);
      await settle();
      expect(player.queue().map((t) => t.id)).toEqual(['q1']);
      expect(toast.toasts()).toHaveLength(0);
    });

    it('keeps an in-flight intent, and prunes one the feed has not shown for a day', () => {
      service.remember('active', 'next', 0);
      service.remember('young', 'next', 0);
      service.remember('old', 'next', 0);
      service.reconcile([job('active', 'active')], GET_INTENT_TTL_MS);
      expect(Object.keys(stored()).sort()).toEqual(['active', 'old', 'young']);
      service.reconcile([job('active', 'active')], GET_INTENT_TTL_MS + 1);
      expect(Object.keys(stored())).toEqual(['active']);
    });
  });

  describe('opt-out', () => {
    it('an intent recorded before opting out lands nothing', async () => {
      playing('q1');
      service.remember('j1', 'next');
      prefs.patch({ queueAcquired: false });
      service.reconcile([job('j1', 'done')]);
      await settle();
      expect(getJobSongs).not.toHaveBeenCalled();
      expect(player.queue().map((t) => t.id)).toEqual(['q1']);
      expect(toast.toasts()).toHaveLength(0);
    });
  });
});
