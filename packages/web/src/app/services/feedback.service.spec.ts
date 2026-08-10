import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { FeedbackService } from './feedback.service';
import { FeedbackSheetService } from './feedback-sheet.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let http: HttpTestingController;
  const isAdmin = signal(true);
  const feedbackCapture = signal(true);

  beforeEach(() => {
    isAdmin.set(true);
    feedbackCapture.set(true);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Real ToastService + FeedbackSheetService (both dependency-free) so the
        // toast-cap drop path is exercised for real, not simulated.
        { provide: AuthService, useValue: { isAdmin, feedbackCapture } },
      ],
    });
    service = TestBed.inject(FeedbackService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('PATCHes a good verdict', () => {
    service.resolve(7, 'good').subscribe();
    const req = http.expectOne('/api/feedback/7');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ verdict: 'good' });
    req.flush({ ok: true });
  });

  it('PATCHes a bad verdict with note + itemFlags', () => {
    service
      .resolve(9, 'bad', {
        note: 'wrong release',
        itemFlags: { correctFolder: { username: 'bob', directory: 'B/Album' } },
      })
      .subscribe();
    const req = http.expectOne('/api/feedback/9');
    expect(req.request.body).toEqual({
      verdict: 'bad',
      note: 'wrong release',
      itemFlags: { correctFolder: { username: 'bob', directory: 'B/Album' } },
    });
    req.flush({ ok: true });
  });

  describe('shouldPrompt (throttle — one toast per hunt event)', () => {
    it('stays true until the id is explicitly marked as prompted', () => {
      expect(service.shouldPrompt(42)).toBe(true);
      // Non-mutating: a caller that never got a toast on screen must be able to
      // ask again (issue #451 — the check used to consume the id itself).
      expect(service.shouldPrompt(42)).toBe(true);
      service.markPrompted(42);
      expect(service.shouldPrompt(42)).toBe(false);
    });

    it('returns false for a falsy/absent feedbackId', () => {
      expect(service.shouldPrompt(undefined)).toBe(false);
      expect(service.shouldPrompt(0)).toBe(false);
    });

    it('prompts again for a genuinely new feedbackId', () => {
      service.markPrompted(1);
      expect(service.shouldPrompt(1)).toBe(false);
      expect(service.shouldPrompt(2)).toBe(true);
    });
  });

  describe('promptForHunt (the capture toast — issue #451)', () => {
    const ctx = (feedbackId?: number) => ({
      feedbackId,
      artistName: 'Pink Floyd',
      albumTitle: 'Wish You Were Here',
      candidates: [{ username: 'bob', directory: 'B/WYWH', matchPct: 90, format: 'FLAC' }],
    });

    function toasts() {
      return TestBed.inject(ToastService).toasts();
    }

    it('shows a 👍/👎 toast for an admin with capture on', () => {
      service.promptForHunt(ctx(7));
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0].actions?.map((a) => a.label)).toEqual(['👍', '👎']);
    });

    it('does not prompt for a non-admin, a capture-off admin, or a missing id', () => {
      isAdmin.set(false);
      service.promptForHunt(ctx(7));
      isAdmin.set(true);
      feedbackCapture.set(false);
      service.promptForHunt(ctx(7));
      feedbackCapture.set(true);
      service.promptForHunt(ctx(undefined));
      expect(toasts()).toHaveLength(0);
    });

    it('prompts at most once per feedbackId', () => {
      service.promptForHunt(ctx(7));
      TestBed.inject(ToastService).reset();
      service.promptForHunt(ctx(7));
      expect(toasts()).toHaveLength(0);
    });

    it('does NOT consume the id when the toast is dropped by the cap', () => {
      // Three live countdown toasts — ToastService drops rather than evicts these.
      const toast = TestBed.inject(ToastService);
      for (let i = 0; i < 3; i++) toast.show({ message: `cd${i}`, kind: 'info', countdown: 10 });

      service.promptForHunt(ctx(7));
      expect(toasts()).toHaveLength(3); // dropped — the user never saw it

      toast.reset();
      service.promptForHunt(ctx(7)); // ...so the next hunt may still offer it
      expect(toasts()).toHaveLength(1);
    });

    it('👍 grades the capture good; 👎 opens the detail sheet', () => {
      service.promptForHunt(ctx(7));
      toasts()[0].actions?.[0].callback();
      http.expectOne('/api/feedback/7').flush({ ok: true });

      TestBed.inject(ToastService).reset();
      service.promptForHunt(ctx(8));
      toasts()[0].actions?.[1].callback();
      expect(TestBed.inject(FeedbackSheetService).payload()).toMatchObject({
        feedbackId: 8,
        albumTitle: 'Wish You Were Here',
      });
    });
  });
});
