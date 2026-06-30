import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { DownloadsApiService } from './downloads-api.service';

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
});
