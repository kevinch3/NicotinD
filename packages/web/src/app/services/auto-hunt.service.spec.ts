import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { AutoHuntService } from './auto-hunt.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import { FeedbackService } from './feedback.service';
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
  const promptForHunt = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    promptForHunt.mockReset();
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
        { provide: FeedbackService, useValue: { promptForHunt } },
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
  describe('generation-feedback capture prompt', () => {
    it('prompts on a confident match, carrying the merged candidates', async () => {
      huntAlbumBase.mockReturnValue(
        of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false, feedbackId: 12 }),
      );
      huntDownload.mockReturnValue(of({ queued: 1 }));

      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await Promise.resolve();

      expect(promptForHunt).toHaveBeenCalledWith(
        expect.objectContaining({
          feedbackId: 12,
          artistName: 'Pink Floyd',
          albumTitle: 'Wish You Were Here',
          candidates: [expect.objectContaining({ username: 'peer1', matchPct: 85 })],
        }),
      );
    });

    it('prompts when no confident match was found — the most valuable sample', async () => {
      huntAlbumBase.mockReturnValue(
        of({ candidates: [], totalTracks: 10, skewNeeded: false, feedbackId: 13 }),
      );

      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await Promise.resolve();

      expect(promptForHunt).toHaveBeenCalledWith(
        expect.objectContaining({ feedbackId: 13, candidates: [] }),
      );
    });

    it('carries the skew-merged candidates, not just the base ones', async () => {
      huntAlbumBase.mockReturnValue(
        of({ candidates: [], totalTracks: 10, skewNeeded: true, feedbackId: 14 }),
      );
      huntAlbumSkew.mockReturnValue(of({ candidates: [candidate(75, 'peer2')] }));
      huntDownload.mockReturnValue(of({ queued: 1 }));

      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await Promise.resolve();

      expect(promptForHunt).toHaveBeenCalledWith(
        expect.objectContaining({
          feedbackId: 14,
          candidates: [expect.objectContaining({ username: 'peer2' })],
        }),
      );
    });

    it('does not prompt when the hunt request itself failed', async () => {
      huntAlbumBase.mockReturnValue(throwError(() => new Error('boom')));

      svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
      await Promise.resolve();

      expect(promptForHunt).not.toHaveBeenCalled();
    });
  });
});
