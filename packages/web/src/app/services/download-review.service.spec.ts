import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { DownloadReviewService } from './download-review.service';
import { ReviewApiService } from './api/review-api.service';
import { AuthService } from './auth.service';
import type { ReviewQueueAlbum } from './api/api-types';

/** Drive jsdom's `document.hidden`, which is a getter with no setter. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function setup(opts: { canCurate?: boolean; pending?: number; queue?: ReviewQueueAlbum[] } = {}) {
  const getCount = vi.fn().mockReturnValue(of({ pending: opts.pending ?? 3 }));
  const getQueue = vi.fn().mockReturnValue(of({ albums: opts.queue ?? [] }));
  const apiStub = { getCount, getQueue };
  const authStub = { canCurate: () => opts.canCurate ?? true };

  TestBed.configureTestingModule({
    providers: [
      { provide: ReviewApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });

  const service = TestBed.inject(DownloadReviewService);
  return { service, getCount, getQueue };
}

describe('DownloadReviewService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() triggers a refresh and pending() reflects the fetched count', async () => {
    const { service, getCount } = setup({ pending: 3 });
    const dispose = service.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(getCount).toHaveBeenCalled();
    expect(service.pending()).toBe(3);
    dispose();
  });

  it('does not fetch when the user cannot curate', async () => {
    const { service, getCount } = setup({ canCurate: false });
    const dispose = service.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(getCount).not.toHaveBeenCalled();
    expect(service.pending()).toBe(0);
    dispose();
  });

  it('refresh() always fetches the count but only fetches the queue when a queue watcher is registered', async () => {
    const { service, getCount, getQueue } = setup();
    await service.refresh();
    expect(getCount).toHaveBeenCalledTimes(1);
    expect(getQueue).not.toHaveBeenCalled();

    const stopWatching = service.watchQueue();
    await service.refresh();
    expect(getQueue).toHaveBeenCalledTimes(1);

    stopWatching();
    await service.refresh();
    expect(getQueue).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping in-flight refreshes into a single fetch', async () => {
    const { service, getCount } = setup();
    const p1 = service.refresh();
    const p2 = service.refresh();
    await Promise.all([p1, p2]);
    expect(getCount).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the timer once the last owner leaves', async () => {
    vi.useFakeTimers();
    const { service, getCount } = setup();
    const dispose1 = service.start();
    const dispose2 = service.start();
    await vi.advanceTimersByTimeAsync(0);
    getCount.mockClear();

    dispose1();
    await vi.advanceTimersByTimeAsync(DownloadReviewService.POLL_MS);
    expect(getCount).toHaveBeenCalled();

    getCount.mockClear();
    dispose2();
    await vi.advanceTimersByTimeAsync(DownloadReviewService.POLL_MS * 2);
    expect(getCount).not.toHaveBeenCalled();
  });

  // Characterization of the visibility pause that predates #717 — kept green
  // across the move to the shared createVisibilityPoller helper.
  describe('visibility pause', () => {
    it('stops fetching while the page is hidden, and catches up on return', async () => {
      vi.useFakeTimers();
      setHidden(false);
      const { service, getCount } = setup();
      const dispose = service.start();
      await vi.advanceTimersByTimeAsync(0);
      const before = getCount.mock.calls.length;

      setHidden(true);
      await vi.advanceTimersByTimeAsync(DownloadReviewService.POLL_MS * 10);
      expect(getCount.mock.calls.length).toBe(before);

      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(getCount.mock.calls.length).toBe(before + 1);
      dispose();
    });
  });
});
