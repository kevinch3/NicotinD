import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CurationApiService } from './curation-api.service';

describe('CurationApiService', () => {
  let svc: CurationApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CurationApiService, provideHttpClient(), provideHttpClientTesting()],
    });
    svc = TestBed.inject(CurationApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('fetches a round', () => {
    svc.getRound().subscribe();
    http.expectOne('/api/library/curation/round').flush({ cases: [] });
  });

  it('fetches the open count', () => {
    svc.getCount().subscribe();
    http.expectOne('/api/library/curation/count').flush({ open: 3 });
  });

  it('posts the chosen option id', () => {
    svc.applyCase('flag:19', 'move').subscribe();
    const req = http.expectOne('/api/library/curation/cases/flag:19/apply');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ optionId: 'move' });
    req.flush({ ok: true, detail: 'done' });
  });
});
