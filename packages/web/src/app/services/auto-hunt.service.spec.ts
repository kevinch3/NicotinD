import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
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

  beforeEach(() => {
    vi.useFakeTimers();
    huntAlbumBase.mockReset();
    huntAlbumSkew.mockReset();
    huntDownload.mockReset();
    kickPoll.mockReset();
    show.mockReset();
    dismiss.mockReset();
    show.mockReturnValue('toast-id');

    TestBed.configureTestingModule({
      providers: [
        AutoHuntService,
        { provide: DownloadsApiService, useValue: { huntAlbumBase, huntAlbumSkew, huntDownload } },
        { provide: TransferService, useValue: { kickPoll } },
        { provide: ToastService, useValue: { show, dismiss } },
      ],
    });
  });

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
      expect.objectContaining({ kind: 'success', message: expect.stringContaining('Wish You Were Here') }),
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
    huntAlbumBase.mockReturnValue(
      of({ candidates: [], totalTracks: 10, skewNeeded: false }),
    );

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
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
    huntDownload.mockReturnValue(
      throwError(() => ({ error: { error: 'already-downloading' } })),
    );

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

  it('runs skew phase when base reports skewNeeded', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [], totalTracks: 10, skewNeeded: true }),
    );
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
});
