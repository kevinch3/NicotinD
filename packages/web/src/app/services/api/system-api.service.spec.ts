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

  it('PUTs merged soulseek credentials + network options', () => {
    service.saveSoulseekSettings('user', 'pass', { listeningPort: 50000, enableUPnP: false }).subscribe();
    const req = http.expectOne('/api/settings/soulseek');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      username: 'user',
      password: 'pass',
      listeningPort: 50000,
      enableUPnP: false,
    });
    req.flush({ ok: true, message: 'saved' });
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
