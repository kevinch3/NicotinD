import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import type { AcquisitionJobView } from '@nicotind/core';
import { AutoHuntService } from './auto-hunt.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import type { DiscographyAlbum, FolderCandidate } from './api/api-types';

const ALBUM: DiscographyAlbum = {
  lidarrId: 42,
  foreignAlbumId: 'fa42',
  title: 'Wish You Were Here',
  localAlbumId: undefined,
} as DiscographyAlbum;

function candidate(matchPct: number, username = 'peer1'): FolderCandidate {
  return {
    username,
    directory: `/Music/${username}`,
    candidateRef: `ref-${username}`,
    files: [{ filename: 'track1.flac', size: 1000 }],
    matchedTracks: 10,
    totalTracks: 10,
    matchPct,
    format: 'FLAC',
    estimatedSizeMb: 100,
    isLive: false,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 1,
  } as FolderCandidate;
}

describe('AutoHuntService', () => {
  const huntAlbumBase = vi.fn();
  const huntAlbumSkew = vi.fn();
  const huntDownload = vi.fn();
  const kickPoll = vi.fn();
  const show = vi.fn<ToastService['show']>();
  const dismiss = vi.fn();
  const acquisitionJobs = signal<AcquisitionJobView[]>([]);
  /** False models ToastService dropping a toast at its cap: shown, never on screen. */
  let toastsVisible = true;
  const toasts = () =>
    toastsVisible ? show.mock.results.map((r) => ({ id: r.value as string })) : [];

  beforeEach(() => {
    vi.useFakeTimers();
    huntAlbumBase.mockReset();
    huntAlbumSkew.mockReset();
    huntDownload.mockReset();
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
        { provide: DownloadsApiService, useValue: { huntAlbumBase, huntAlbumSkew, huntDownload } },
        { provide: TransferService, useValue: { kickPoll, acquisitionJobs } },
        { provide: ToastService, useValue: { show, dismiss, toasts } },
      ],
    });
  });

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  function job(over: Partial<AcquisitionJobView>): AcquisitionJobView {
    return {
      id: 'j1',
      state: 'active',
      stage: 'downloading',
      lidarrAlbumId: 42,
      createdAt: 1,
      ...over,
    } as AcquisitionJobView;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  function svc(): AutoHuntService {
    return TestBed.inject(AutoHuntService);
  }

  it('shows a countdown toast when best match is ≥60%', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    const service = svc();
    service.hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve(); // flush microtask queue

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Wish You Were Here'),
        countdown: 3,
        kind: 'info',
      }),
    );
  });

  it('auto-downloads when countdown expires', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    // Capture the first-action callback (the auto-download)
    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    downloadCb?.();
    await Promise.resolve();

    expect(huntDownload).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        selected: expect.objectContaining({ username: 'peer1' }),
      }),
      false,
    );
  });

  it('calls kickPoll and shows success toast after successful download', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    expect(kickPoll).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        message: expect.stringContaining('Wish You Were Here'),
      }),
    );
  });

  it('calls openManual() when "Choose Manually" action is invoked', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    const openManual = vi.fn();
    let manualCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      // "Choose Manually" is the last action on the countdown toast
      manualCb = config.actions?.at(-1)?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', openManual);
    await Promise.resolve();
    manualCb?.();

    expect(openManual).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('toast-id');
  });

  it('shows error toast when best match is <60%', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(45)], totalTracks: 10, skewNeeded: false }),
    );

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('Wish You Were Here'),
      }),
    );
    expect(huntDownload).not.toHaveBeenCalled();
  });

  it('shows error toast when no candidates are found', async () => {
    huntAlbumBase.mockReturnValue(of({ candidates: [], totalTracks: 10, skewNeeded: false }));

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  // #1049: the source cut the hunt short (its two search lanes were held by
  // other work). "No confident match" would be a claim about the album we
  // cannot make; the toast names the cause and offers an immediate retry.
  it('says the source was busy, with a Retry, when the hunt was cut short', async () => {
    huntAlbumBase.mockReturnValue(
      of({
        candidates: [],
        totalTracks: 10,
        skewNeeded: false,
        searchesFired: 6,
        searchesAnswered: 2,
      }),
    );

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('only 2 of 6 searches') }),
    );
    const labels = show.mock.calls[0]![0].actions?.map((a) => a.label);
    expect(labels).toEqual(['Retry', 'Find Manually']);
    expect(show).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('No confident match') }),
    );
  });

  it('says the source is offline, with no retry, when it never searched', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [], totalTracks: 10, skewNeeded: false, sourceOffline: true }),
    );

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/offline/i) }),
    );
    expect(show.mock.calls[0]![0].actions?.map((a) => a.label)).toEqual(['Dismiss']);
  });

  describe('per-album status', () => {
    const OTHER = { ...ALBUM, lidarrId: 7, title: 'Animals' } as DiscographyAlbum;

    /** Hunt to the countdown toast and hand back its actions. */
    async function toCountdown(): Promise<{ label: string; callback: () => void }[]> {
      huntAlbumBase.mockReturnValue(
        of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
      );
      huntDownload.mockReturnValue(of({ queued: 1 }));
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      return show.mock.calls.find((c) => c[0].countdown)![0].actions!;
    }

    it('settles back to idle once a no-match hunt has toasted', async () => {
      huntAlbumBase.mockReturnValue(of({ candidates: [], totalTracks: 10, skewNeeded: false }));
      const service = svc();
      service.hunt(ALBUM, 'Pink Floyd', vi.fn());
      expect(service.statusFor(42)).toEqual({ phase: 'searching' });
      await flush();
      expect(service.statusFor(42)).toEqual({ phase: 'idle' });
    });

    // The bug behind "clicked twice, got surprises": the hold used to drop when
    // the search resolved — before the countdown even started.
    it('stays searching through the countdown', async () => {
      await toCountdown();
      expect(svc().statusFor(42)).toEqual({ phase: 'searching' });
    });

    it('holds until the job is polled in, then shows the job stage', async () => {
      let resolvePoll!: () => void;
      kickPoll.mockReturnValue(new Promise<void>((r) => (resolvePoll = r)));
      const [downloadNow] = await toCountdown();
      downloadNow!.callback();
      await flush();
      expect(huntDownload).toHaveBeenCalledTimes(1);
      expect(svc().statusFor(42)).toEqual({ phase: 'searching' });

      acquisitionJobs.set([job({ stage: 'queued' })]);
      resolvePoll();
      await flush();
      expect(svc().statusFor(42)).toEqual({ phase: 'job', stage: 'queued' });
    });

    it('releases on Cancel and on Choose Manually', async () => {
      const cancel = (await toCountdown()).find((a) => a.label === 'Cancel')!;
      cancel.callback();
      expect(svc().statusFor(42)).toEqual({ phase: 'idle' });

      show.mockClear();
      const manual = (await toCountdown()).find((a) => a.label === 'Choose Manually')!;
      manual.callback();
      expect(svc().statusFor(42)).toEqual({ phase: 'idle' });
    });

    it('releases when the enqueue fails', async () => {
      huntAlbumBase.mockReturnValue(
        of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
      );
      huntDownload.mockReturnValue(throwError(() => ({ status: 400, error: { error: 'nope' } })));
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await flush();
      show.mock.calls.find((c) => c[0].countdown)![0].actions![0]!.callback();
      await flush();
      expect(svc().statusFor(42)).toEqual({ phase: 'idle' });
    });

    // At the toast cap the countdown is dropped unseen and never fires — nothing
    // would ever release the album, so the manual picker takes over.
    it('falls back to the manual picker when the countdown toast is dropped', async () => {
      toastsVisible = false;
      huntAlbumBase.mockReturnValue(
        of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
      );
      const openManual = vi.fn();
      svc().hunt(ALBUM, 'Pink Floyd', openManual);
      await flush();
      expect(openManual).toHaveBeenCalledTimes(1);
      expect(svc().statusFor(42)).toEqual({ phase: 'idle' });
    });

    it('ignores a second hunt() while the album has a live job', async () => {
      acquisitionJobs.set([job({})]);
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      expect(huntAlbumBase).not.toHaveBeenCalled();
    });

    it('never blocks a different album', async () => {
      await toCountdown();
      const service = svc();
      expect(service.statusFor(OTHER.lidarrId)).toEqual({ phase: 'idle' });
      service.hunt(OTHER, 'Pink Floyd', vi.fn());
      expect(huntAlbumBase).toHaveBeenCalledTimes(2);
    });

    it('joins only active jobs, newest first', () => {
      acquisitionJobs.set([
        job({ id: 'old', stage: 'queued', createdAt: 1 }),
        job({ id: 'new', stage: 'organizing', createdAt: 2 }),
        job({ id: 'done', state: 'done', stage: 'done', createdAt: 3 }),
        job({ id: 'other', lidarrAlbumId: 7, state: 'failed', stage: 'error' }),
      ]);
      const service = svc();
      expect(service.statusFor(42)).toEqual({ phase: 'job', stage: 'organizing' });
      expect(service.statusFor(7)).toEqual({ phase: 'idle' });
    });

    it('refcounts holds, so the modal ending cannot clear an auto-hunt', () => {
      const service = svc();
      service.beginSearch(42);
      service.beginSearch(42);
      service.endSearch(42);
      expect(service.statusFor(42)).toEqual({ phase: 'searching' });
      service.endSearch(42);
      expect(service.statusFor(42)).toEqual({ phase: 'idle' });
    });
  });

  it('shows error toast when hunt throws', async () => {
    huntAlbumBase.mockReturnValue(throwError(() => new Error('network error')));

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('shows info toast (not error) on 409 already-downloading', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(throwError(() => ({ error: { error: 'already-downloading' } })));

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    const lastCall = show.mock.calls.at(-1)?.[0];
    expect(lastCall?.kind).toBe('info');
  });

  it('shows info toast (not error) on 409 already-complete', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 0, alreadyComplete: true }));

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    const lastCall = show.mock.calls.at(-1)?.[0];
    expect(lastCall?.kind).toBe('info');
  });

  it('ignores a second hunt() call for the same lidarrId while one is in flight', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    const service = svc();
    service.hunt(ALBUM, 'Pink Floyd', vi.fn());
    service.hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(huntAlbumBase).toHaveBeenCalledTimes(1);
  });

  it('Dismiss action on no-match error toast calls dismiss()', async () => {
    huntAlbumBase.mockReturnValue(of({ candidates: [], totalTracks: 10, skewNeeded: false }));
    let dismissCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      // Dismiss is the first action on error toasts
      dismissCb = config.actions?.[0]?.callback;
      return 'toast-err-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    dismissCb?.();
    expect(dismiss).toHaveBeenCalledWith('toast-err-id');
  });

  it('runs skew phase when base reports skewNeeded', async () => {
    huntAlbumBase.mockReturnValue(of({ candidates: [], totalTracks: 10, skewNeeded: true }));
    huntAlbumSkew.mockReturnValue(of({ candidates: [candidate(75)] }));
    huntDownload.mockReturnValue(of({ queued: 1 }));

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(huntAlbumSkew).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ artistName: 'Pink Floyd' }),
    );
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ countdown: 3 }));
  });

  // Issue #530: the addon-cutover server requires the hunt candidate token —
  // without it every one-click download 400s ("Selection expired") while the
  // manual modal (which sends it) works.
  it('sends the chosen candidate’s candidateRef', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb ??= config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    expect(huntDownload).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        selected: expect.objectContaining({ candidateRef: 'ref-peer1' }),
      }),
      false,
    );
  });

  describe('bounded auto-retry on enqueue failure (issue #530)', () => {
    /** Run the hunt and fire the countdown toast's Download Now action. */
    async function runDownload(cands: FolderCandidate[]): Promise<void> {
      huntAlbumBase.mockReturnValue(of({ candidates: cands, totalTracks: 10, skewNeeded: false }));
      let downloadCb: (() => void) | undefined;
      show.mockImplementation((config) => {
        downloadCb ??= config.actions?.[0]?.callback;
        return 'toast-id';
      });
      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await Promise.resolve();
      downloadCb?.();
      // Each retry hop chains another request; flush a few microtask rounds.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }

    const offline = (user: string) => ({
      status: 502,
      error: { error: `Download failed for user "${user}" — they may be offline` },
    });

    it('tries the next viable candidate when the first peer is unavailable', async () => {
      huntDownload
        .mockReturnValueOnce(throwError(() => offline('peer1')))
        .mockReturnValueOnce(of({ queued: 1 }));

      await runDownload([candidate(85, 'peer1'), candidate(80, 'peer2')]);

      expect(huntDownload).toHaveBeenCalledTimes(2);
      expect(huntDownload).toHaveBeenLastCalledWith(
        42,
        expect.objectContaining({
          selected: expect.objectContaining({ username: 'peer2', candidateRef: 'ref-peer2' }),
        }),
        false,
      );
      const lastToast = show.mock.calls.at(-1)?.[0];
      expect(lastToast?.kind).toBe('success');
    });

    it('stops after 3 attempts and surfaces the last reason', async () => {
      huntDownload.mockReturnValue(throwError(() => offline('somebody')));

      await runDownload([
        candidate(85, 'peer1'),
        candidate(80, 'peer2'),
        candidate(75, 'peer3'),
        candidate(70, 'peer4'),
      ]);

      expect(huntDownload).toHaveBeenCalledTimes(3);
      const lastToast = show.mock.calls.at(-1)?.[0];
      expect(lastToast?.kind).toBe('error');
      expect(lastToast?.message).toContain('they may be offline');
    });

    it('does not retry a terminal 400 and surfaces its message', async () => {
      huntDownload.mockReturnValue(
        throwError(() => ({
          status: 400,
          error: { error: 'Selection expired — run the search again' },
        })),
      );

      await runDownload([candidate(85, 'peer1'), candidate(80, 'peer2')]);

      expect(huntDownload).toHaveBeenCalledTimes(1);
      const lastToast = show.mock.calls.at(-1)?.[0];
      expect(lastToast?.kind).toBe('error');
      expect(lastToast?.message).toContain('Selection expired');
    });

    it('never retries with a below-threshold candidate', async () => {
      huntDownload.mockReturnValue(throwError(() => offline('peer1')));

      await runDownload([candidate(85, 'peer1'), candidate(45, 'peer2')]);

      expect(huntDownload).toHaveBeenCalledTimes(1);
      const lastToast = show.mock.calls.at(-1)?.[0];
      expect(lastToast?.kind).toBe('error');
    });
  });

  // Issue #451: this path creates the generation_feedback row server-side but
  // never offered a grading prompt, so ~39 prod captures were never graded.
});
