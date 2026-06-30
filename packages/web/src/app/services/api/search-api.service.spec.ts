import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { SearchApiService } from './search-api.service';

describe('SearchApiService', () => {
  let service: SearchApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SearchApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs /api/search with the q param', () => {
    service.search('pink floyd').subscribe();
    const req = http.expectOne((r) => r.url === '/api/search');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('q')).toBe('pink floyd');
    req.flush({});
  });

  it('POSTs the resolve payload to /api/catalog/resolve', () => {
    const payload = {
      foreignAlbumId: 'fa',
      artistMbid: 'mb',
      artistName: 'Pink Floyd',
      albumTitle: 'DSOTM',
    };
    service.catalogResolve(payload).subscribe();
    const req = http.expectOne('/api/catalog/resolve');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush({});
  });
});
