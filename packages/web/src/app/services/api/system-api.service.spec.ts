import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { SystemApiService } from './system-api.service';

describe('SystemApiService', () => {
  let service: SystemApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SystemApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs system status', () => {
    service.getStatus().subscribe();
    const req = http.expectOne('/api/system/status');
    expect(req.request.method).toBe('GET');
    req.flush({ slskd: { healthy: true } });
  });

  it('POSTs setup completion to /api/setup/complete', () => {
    const data = { admin: { username: 'a', password: 'p' } };
    service.completeSetup(data).subscribe();
    const req = http.expectOne('/api/setup/complete');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(data);
    req.flush({ token: 't', user: { id: '1', username: 'a', role: 'admin' } });
  });
});
