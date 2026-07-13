import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AcquireService, type AcquireJob } from './acquire.service';
import { ToastService } from './toast.service';

function job(over: Partial<AcquireJob> = {}): AcquireJob {
  return {
    id: 'j1',
    state: 'done',
    url: 'http://example.com/track',
    backend: 'ytdlp',
    label: null,
    progress: null,
    error: null,
    created_at: 0,
    ...over,
  };
}

describe('AcquireService', () => {
  const get = vi.fn();
  const show = vi.fn();
  let svc: AcquireService;

  beforeEach(() => {
    get.mockReset();
    show.mockReset();
    get.mockReturnValue(of([]));

    TestBed.configureTestingModule({
      providers: [
        AcquireService,
        { provide: HttpClient, useValue: { get, post: vi.fn(), delete: vi.fn() } },
        { provide: ToastService, useValue: { show, reset: vi.fn() } },
      ],
    });
    svc = TestBed.inject(AcquireService);
  });

  describe('first-refresh toast suppression', () => {
    it('does not toast done jobs on first refresh', async () => {
      get.mockReturnValue(of([job({ id: 'j1', state: 'done', error: null })]));
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });

    it('does not toast done-with-error jobs on first refresh', async () => {
      get.mockReturnValue(of([job({ id: 'j1', state: 'done', error: 'partial download' })]));
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });

    it('does not toast failed jobs on first refresh', async () => {
      get.mockReturnValue(of([job({ id: 'j1', state: 'failed', error: 'network error' })]));
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });

    it('does not toast failed jobs with null error on first refresh', async () => {
      get.mockReturnValue(of([job({ id: 'j1', state: 'failed', error: null })]));
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });

    it('still hydrates jobs signal on first refresh', async () => {
      const doneJob = job({ id: 'j1', state: 'done' });
      get.mockReturnValue(of([doneJob]));
      await svc.refresh();
      expect(svc.jobs()).toEqual([doneJob]);
    });
  });

  describe('toasts on subsequent refreshes', () => {
    it('toasts when a new done job appears', async () => {
      // First refresh — empty baseline
      await svc.refresh();

      // Second refresh — new done job
      get.mockReturnValue(of([job({ id: 'j1', state: 'done', error: null })]));
      await svc.refresh();

      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Your track has been added to the library.',
          kind: 'success',
        }),
      );
    });

    it('toasts error when a done job carries a partial-download warning', async () => {
      await svc.refresh();

      get.mockReturnValue(of([job({ id: 'j1', state: 'done', error: 'only 2 of 3 tracks matched' })]));
      await svc.refresh();

      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'only 2 of 3 tracks matched', kind: 'error' }),
      );
    });

    it('toasts when a new failed job appears', async () => {
      await svc.refresh();

      get.mockReturnValue(of([job({ id: 'j1', state: 'failed', error: 'download timed out' })]));
      await svc.refresh();

      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'download timed out', kind: 'error' }),
      );
    });

    it('toasts fallback message when a failed job has null error', async () => {
      await svc.refresh();

      get.mockReturnValue(of([job({ id: 'j1', state: 'failed', error: null })]));
      await svc.refresh();

      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Download failed.', kind: 'error' }),
      );
    });

    it('does not toast a job that was already seen as done', async () => {
      const doneJob = job({ id: 'j1', state: 'done' });
      get.mockReturnValue(of([doneJob]));
      await svc.refresh(); // baselines

      // Same job still done on next refresh
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });

    it('does not toast queued or running jobs', async () => {
      await svc.refresh();

      get.mockReturnValue(of([job({ id: 'j1', state: 'running' })]));
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });
  });

  describe('reset re-baselines', () => {
    it('suppresses toasts again after reset', async () => {
      const doneJob = job({ id: 'j1', state: 'done' });
      get.mockReturnValue(of([doneJob]));
      await svc.refresh(); // baselines silently

      svc.reset();

      // Same done job after reset should again be suppressed
      get.mockReturnValue(of([doneJob]));
      await svc.refresh();
      expect(show).not.toHaveBeenCalled();
    });
  });
});
