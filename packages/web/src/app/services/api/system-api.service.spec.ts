import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { SystemApiService } from './system-api.service';
import { KEEP_SESSION_ON_401 } from '../../lib/http-context';

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

  it('flags a background radio-settings read so its 401 keeps the session', () => {
    service.getRadioSettings({ background: true }).subscribe({ error: () => {} });
    const req = http.expectOne('/api/settings/radio');
    expect(req.request.context.get(KEEP_SESSION_ON_401)).toBe(true);
    req.flush({}, { status: 401, statusText: 'Unauthorized' });
  });

  it('leaves an ordinary radio-settings read to the normal 401 handling', () => {
    service.getRadioSettings().subscribe();
    const req = http.expectOne('/api/settings/radio');
    expect(req.request.context.get(KEEP_SESSION_ON_401)).toBe(false);
    req.flush({});
  });
});
