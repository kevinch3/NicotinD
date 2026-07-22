import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { FeedbackService } from './feedback.service';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
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
    it('returns true the first time it sees a feedbackId, false thereafter', () => {
      expect(service.shouldPrompt(42)).toBe(true);
      expect(service.shouldPrompt(42)).toBe(false);
    });

    it('returns false for a falsy/absent feedbackId', () => {
      expect(service.shouldPrompt(undefined)).toBe(false);
      expect(service.shouldPrompt(0)).toBe(false);
    });

    it('prompts again for a genuinely new feedbackId', () => {
      expect(service.shouldPrompt(1)).toBe(true);
      expect(service.shouldPrompt(2)).toBe(true);
      expect(service.shouldPrompt(1)).toBe(false);
    });
  });
});
