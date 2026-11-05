import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { DownloadsApiService, HUNT_POLL_MS, HuntFailedError } from './downloads-api.service';

describe('DownloadsApiService', () => {
  let service: DownloadsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DownloadsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('POSTs an enqueue request to /api/downloads', () => {
    const files = [{ filename: 'a.flac', size: 1 }];
    service.enqueueDownload('peer', files).subscribe();
    const req = http.expectOne('/api/downloads');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ username: 'peer', files });
    req.flush({ ok: true });
  });

  it('GETs album jobs filtered by state', () => {
    service.listAlbumJobs('exhausted').subscribe();
    const req = http.expectOne((r) => r.url === '/api/discography/jobs');
    expect(req.request.params.get('state')).toBe('exhausted');
    req.flush({ jobs: [] });
  });

  it('adds the replace param to hunt-download only when requested', () => {
    const payload = { selected: { username: 'u', directory: 'd', files: [] }, alternates: [] };
    service.huntDownload(7, payload, true).subscribe();
    const req = http.expectOne((r) => r.url === '/api/discography/albums/7/hunt-download');
    expect(req.request.method).toBe('POST');
    expect(req.request.params.get('replace')).toBe('true');
    req.flush({ ok: true, queued: 1 });
  });

  // #1625: a hunt waits its turn on the server, not inside a 55 s request.
  describe('huntAlbumBase queues, then polls', () => {
    const RESULT = {
      candidates: [],
      totalTracks: 3,
      skewNeeded: false,
      searchesFired: 2,
      searchesAnswered: 2,
    };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('posts to the queue, reports the wait, and emits the result once', () => {
      const waits: unknown[] = [];
      const results: unknown[] = [];
      service
        .huntAlbumBase(9, { albumTitle: 'X' }, (w) => waits.push(w))
        .subscribe((r) => results.push(r));
      const post = http.expectOne('/api/discography/albums/9/hunt/queue');
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toEqual({ albumTitle: 'X' });
      post.flush({ huntId: 'h1', state: 'queued', position: 2, etaMs: 24_000 });

      http
        .expectOne('/api/discography/hunts/h1')
        .flush({ state: 'queued', position: 2, etaMs: 24_000 });
      vi.advanceTimersByTime(HUNT_POLL_MS);
      http
        .expectOne('/api/discography/hunts/h1')
        .flush({ state: 'searching', elapsedMs: 1, etaMs: 11_000 });
      vi.advanceTimersByTime(HUNT_POLL_MS);
      http.expectOne('/api/discography/hunts/h1').flush({ state: 'done', result: RESULT });

      expect(waits).toEqual([
        { state: 'queued', position: 2, etaMs: 24_000 },
        { state: 'searching', elapsedMs: 1, etaMs: 11_000 },
      ]);
      expect(results).toEqual([RESULT]);
      // Settled: no further poll.
      vi.advanceTimersByTime(HUNT_POLL_MS * 3);
      http.expectNone('/api/discography/hunts/h1');
    });

    it('a hunt that ran and failed errors with its reason', () => {
      let error: unknown;
      service.huntAlbumBase(9).subscribe({ error: (e) => (error = e) });
      http.expectOne('/api/discography/albums/9/hunt/queue').flush({ huntId: 'h2' });
      http.expectOne('/api/discography/hunts/h2').flush({
        state: 'failed',
        error: 'The source did not finish searching in time.',
        timedOut: true,
      });
      expect(error).toBeInstanceOf(HuntFailedError);
      expect((error as HuntFailedError).timedOut).toBe(true);
      expect((error as Error).message).toContain('in time');
    });
  });
});
