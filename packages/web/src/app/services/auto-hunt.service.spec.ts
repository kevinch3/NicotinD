import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import type { AcquisitionJobView } from '@nicotind/core';
import { AutoHuntService } from './auto-hunt.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import { Router } from '@angular/router';
import type { DiscographyAlbum } from './api/api-types';
import { TranslateService } from './translate.service';
import EN_CATALOG from '../../../public/i18n/en.json';
import ES_CATALOG from '../../../public/i18n/es.json';

/** Serves the shipped catalogs, so the toasts are asserted in the words a listener reads. */
const catalogFetch = (async (url: string) =>
  new Response(JSON.stringify(url.endsWith('/es.json') ? ES_CATALOG : EN_CATALOG))) as typeof fetch;

const ALBUM: DiscographyAlbum = {
  lidarrId: 42,
  foreignAlbumId: 'fa42',
  title: 'Wish You Were Here',
  localAlbumId: undefined,
} as DiscographyAlbum;

describe('AutoHuntService', () => {
  const getAlbum = vi.fn();
  const cancelJob = vi.fn();
  const kickPoll = vi.fn();
  const show = vi.fn<ToastService['show']>();
  const dismiss = vi.fn();
  const acquisitionJobs = signal<AcquisitionJobView[]>([]);
  /** False models ToastService dropping a toast at its cap: shown, never on screen. */
  let toastsVisible = true;
  const toasts = () =>
    toastsVisible ? show.mock.results.map((r) => ({ id: r.value as string })) : [];

  beforeEach(async () => {
    getAlbum.mockReset();
    getAlbum.mockReturnValue(of({ jobId: 'j1' }));
    cancelJob.mockReset();
    cancelJob.mockReturnValue(of({ ok: true }));
    kickPoll.mockReset();
    kickPoll.mockResolvedValue(undefined);
    show.mockReset();
    dismiss.mockReset();
    show.mockReturnValue('toast-id');
    acquisitionJobs.set([]);
    toastsVisible = true;

    TestBed.configureTestingModule({
      providers: [
        AutoHuntService,
        { provide: DownloadsApiService, useValue: { getAlbum, cancelJob } },
        { provide: TransferService, useValue: { kickPoll, acquisitionJobs } },
        { provide: ToastService, useValue: { show, dismiss, toasts } },
      ],
    });
    localStorage.clear();
    const i18n = TestBed.inject(TranslateService);
    await i18n.init(catalogFetch);
    await i18n.use('en', catalogFetch, { choice: false });
    vi.useFakeTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  function job(over: Partial<AcquisitionJobView>): AcquisitionJobView {
    return {
      id: 'j1',
      state: 'active',
      stage: 'downloading',
      kind: 'album-hunt',
      lidarrAlbumId: 42,
      artistName: null,
      albumTitle: null,
      createdAt: 1,
      progress: { expected: 10, delivered: 3, unavailable: 0, canonical: 10 },
      ...over,
    } as AcquisitionJobView;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  function svc(): AutoHuntService {
    return TestBed.inject(AutoHuntService);
  }

  const OTHER = { ...ALBUM, lidarrId: 43, title: 'Animals' } as DiscographyAlbum;
  const httpError = (status: number, error: unknown) =>
    throwError(() => new HttpErrorResponse({ status, error }));
  /** Let the feed effect see the jobs signal. */
  const feed = (jobs: AcquisitionJobView[]) => {
    acquisitionJobs.set(jobs);
    TestBed.tick();
  };
  const messages = () => show.mock.calls.map(([t]) => t.message);
  const labels = (call = show.mock.calls.length - 1) =>
    (show.mock.calls[call]![0].actions ?? []).map((a) => a.label);

  describe('a click', () => {
    it('is one request naming the album, and no toast', async () => {
      svc().hunt({ ...ALBUM, localAlbumId: 'local-9' } as DiscographyAlbum, 'Pink Floyd', vi.fn());
      await flush();
      expect(getAlbum).toHaveBeenCalledTimes(1);
      expect(getAlbum).toHaveBeenCalledWith(42, {
        artistName: 'Pink Floyd',
        albumTitle: 'Wish You Were Here',
        localAlbumId: 'local-9',
      });
      expect(kickPoll).toHaveBeenCalledTimes(1);
      expect(show).not.toHaveBeenCalled();
    });

    it('says nothing when the job goes on to download', async () => {
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      feed([job({ stage: 'resolving' })]);
      feed([job({ stage: 'downloading' })]);
      feed([job({ state: 'done', stage: 'done' })]);
      expect(show).not.toHaveBeenCalled();
    });

    it('a searching Get names its job, so the surface can cancel it', async () => {
      const service = svc();
      feed([job({ stage: 'resolving' })]);
      expect(service.statusFor(42)).toEqual({ phase: 'searching', jobId: 'j1' });
    });

    it('cancels through the job route and stays quiet when the job then closes', async () => {
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      feed([job({ stage: 'resolving' })]);
      await service.cancel('j1');
      feed([job({ state: 'failed', stage: 'error', error: 'Cancelled by user' })]);

      expect(cancelJob).toHaveBeenCalledWith('j1');
      expect(show).not.toHaveBeenCalled();
    });

    it('ignores a second click while the first is in flight', async () => {
      getAlbum.mockReturnValue(NEVER);
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      expect(getAlbum).toHaveBeenCalledTimes(1);
    });

    it('ignores a click on an album a job is already fetching', () => {
      feed([job({})]);
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      expect(getAlbum).not.toHaveBeenCalled();
    });
  });

  describe('per-album status', () => {
    it('is searching from the click until the job is in the feed', async () => {
      let polled!: () => void;
      kickPoll.mockReturnValue(new Promise<void>((r) => (polled = r)));
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      expect(service.statusFor(42).phase).toBe('searching');

      feed([job({ stage: 'downloading' })]);
      polled();
      await flush();
      expect(service.statusFor(42)).toMatchObject({ phase: 'job', stage: 'downloading' });
    });

    it('reads a job the server has not found a source for yet as searching', () => {
      feed([job({ stage: 'resolving' })]);
      expect(svc().statusFor(42).phase).toBe('searching');
    });

    it('settles back to idle when the request is refused', async () => {
      getAlbum.mockReturnValue(httpError(503, { error: 'No acquisition addon registered' }));
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      expect(service.statusFor(42).phase).toBe('idle');
    });

    it('never blocks a different album', () => {
      getAlbum.mockReturnValue(NEVER);
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      expect(service.statusFor(43).phase).toBe('idle');
    });

    it('refcounts holds, so the modal ending cannot clear a Get', () => {
      getAlbum.mockReturnValue(NEVER);
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      service.beginSearch(42);
      service.endSearch(42);
      expect(service.statusFor(42).phase).toBe('searching');
    });
  });

  describe('a request the server refuses', () => {
    it('is an info notice when the album is already in the library', async () => {
      getAlbum.mockReturnValue(httpError(409, { error: 'already-complete' }));
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      expect(show).toHaveBeenCalledTimes(1);
      expect(show.mock.calls[0]![0]).toMatchObject({
        kind: 'info',
        message: 'You already have "Wish You Were Here"',
      });
    });

    it('links to Downloads when the album is already downloading', async () => {
      getAlbum.mockReturnValue(httpError(409, { error: 'already-downloading' }));
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      expect(show.mock.calls[0]![0].kind).toBe('info');
      expect(labels()).toEqual(['View in Downloads']);
    });

    it('is a failure with the server reason and the manual picker', async () => {
      getAlbum.mockReturnValue(httpError(503, { error: 'No acquisition addon registered' }));
      const openManual = vi.fn();
      svc().hunt(ALBUM, 'Pink Floyd', openManual);
      await flush();
      expect(show.mock.calls[0]![0]).toMatchObject({
        kind: 'error',
        message: `Couldn't get "Wish You Were Here" — No acquisition addon registered`,
      });
      expect(labels()).toEqual(['Dismiss', 'Find Manually']);
      show.mock.calls[0]![0].actions![1]!.callback();
      expect(openManual).toHaveBeenCalledTimes(1);
    });
  });

  describe('a Get the server could not finish', () => {
    const failed = (over: Partial<AcquisitionJobView> = {}) =>
      job({ state: 'failed', stage: 'error', error: 'No confident match', ...over });

    it('toasts once, with the reason from the job', async () => {
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      feed([job({ stage: 'resolving' })]);
      expect(show).not.toHaveBeenCalled();

      feed([failed()]);
      feed([failed()]);
      expect(messages()).toEqual([`Couldn't get "Wish You Were Here" — No confident match`]);
      expect(labels()).toEqual(['Dismiss', 'Find Manually']);
    });

    it('folds a second failure into the toast on screen, pointing at Downloads', async () => {
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      getAlbum.mockReturnValue(of({ jobId: 'j2' }));
      service.hunt(OTHER, 'Pink Floyd', vi.fn());
      await flush();

      feed([failed()]);
      feed([failed(), failed({ id: 'j2', lidarrAlbumId: 43 })]);
      expect(dismiss).toHaveBeenCalledWith('toast-id');
      expect(messages()[1]).toBe(`2 albums couldn't be fetched: "Wish You Were Here", "Animals"`);
      expect(labels()).toEqual(['Dismiss', 'View in Downloads']);
    });

    it('starts a fresh toast once the last one has left the screen', async () => {
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      getAlbum.mockReturnValue(of({ jobId: 'j2' }));
      service.hunt(OTHER, 'Pink Floyd', vi.fn());
      await flush();

      feed([failed()]);
      toastsVisible = false;
      feed([failed(), failed({ id: 'j2', lidarrAlbumId: 43 })]);
      expect(messages()[1]).toBe(`Couldn't get "Animals" — No confident match`);
    });

    it('remembers the failure for the card, and forgets it on the next Get', async () => {
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      feed([failed()]);
      expect(service.failureFor(ALBUM.lidarrId)).toBe('No confident match');
      expect(service.failureFor(null)).toBeNull();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      expect(service.failureFor(ALBUM.lidarrId)).toBeNull();
    });

    it('says nothing about a job the person cancelled', async () => {
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      feed([failed({ cancelRequested: true, error: 'Cancelled by user' })]);
      expect(show).not.toHaveBeenCalled();
    });

    it('says nothing about a failed job this session never asked for', () => {
      svc();
      feed([failed({ id: 'someone-elses' })]);
      expect(show).not.toHaveBeenCalled();
    });
  });

  describe('statusForAlbum', () => {
    it('reports a live job by Lidarr id, with its progress and id', () => {
      acquisitionJobs.set([job({ id: 'j9', stage: 'downloading' })]);
      expect(svc().statusForAlbum({ lidarrAlbumId: 42 })).toEqual({
        phase: 'job',
        stage: 'downloading',
        jobId: 'j9',
        delivered: 3,
        expected: 10,
      });
    });

    it('finds a peer-folder grab of the album by name — no Lidarr id on it', () => {
      acquisitionJobs.set([
        job({
          id: 'folder-1',
          kind: 'direct',
          lidarrAlbumId: null,
          artistName: 'Damian Lazarus & The Ancient Moons',
          albumTitle: 'Message From The Other Side',
        }),
      ]);
      const status = svc().statusForAlbum({
        artist: 'Damian Lazarus',
        title: 'Message From the Other Side',
        lidarrAlbumId: 4275,
      });
      expect(status).toMatchObject({ phase: 'job', jobId: 'folder-1' });
    });

    it('stays idle for another album by the same artist, and for a finished job', () => {
      acquisitionJobs.set([
        job({ lidarrAlbumId: null, artistName: 'Christian Löffler', albumTitle: 'Mare Reworks' }),
        job({
          id: 'done',
          state: 'done',
          lidarrAlbumId: null,
          artistName: 'Christian Löffler',
          albumTitle: 'Mare',
        }),
      ]);
      expect(svc().statusForAlbum({ artist: 'Christian Löffler', title: 'Mare' })).toEqual({
        phase: 'idle',
      });
    });

    it('prints no count for a URL job whose total is not committed yet', () => {
      acquisitionJobs.set([
        job({
          kind: 'url',
          lidarrAlbumId: null,
          artistName: 'A',
          albumTitle: 'B',
          progress: { expected: 4, delivered: 1, unavailable: 0, canonical: null },
        } as Partial<AcquisitionJobView>),
      ]);
      const status = svc().statusForAlbum({ artist: 'A', title: 'B' });
      expect(status).toMatchObject({ phase: 'job' });
      expect(status).not.toHaveProperty('expected');
    });
  });

  describe('in Spanish (#1840)', () => {
    beforeEach(async () => {
      vi.useRealTimers();
      await TestBed.inject(TranslateService).use('es', catalogFetch, { choice: false });
      vi.useFakeTimers();
    });

    it('says the album is already owned in Spanish, with the title interpolated', async () => {
      getAlbum.mockReturnValue(httpError(409, { error: 'already-complete' }));
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      expect(messages()).toEqual(['Ya tienes "Wish You Were Here"']);
    });

    it('translates a failure and its actions', async () => {
      getAlbum.mockReturnValue(httpError(503, { error: 'Sin coincidencias' }));
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      expect(messages()).toEqual(['No se pudo conseguir "Wish You Were Here" — Sin coincidencias']);
      expect(labels()).toEqual(['Cerrar', 'Buscar manualmente']);
    });

    it('translates a failed cancel', async () => {
      cancelJob.mockReturnValue(httpError(500, {}));
      await svc().cancel('j1');
      expect(messages()).toEqual(['No se pudo cancelar — inténtalo desde Descargas']);
    });
  });
});
