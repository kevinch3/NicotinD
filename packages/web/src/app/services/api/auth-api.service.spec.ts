import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { AuthApiService } from './auth-api.service';

describe('AuthApiService', () => {
  let service: AuthApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('POSTs credentials to /api/auth/login', () => {
    service.login('alice', 'secret').subscribe();
    const req = http.expectOne('/api/auth/login');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ username: 'alice', password: 'secret' });
    req.flush({ token: 't', user: { id: '1', username: 'alice', role: 'admin' } });
  });

  it('GETs the registration status', () => {
    service.getRegistrationStatus().subscribe();
    const req = http.expectOne('/api/auth/registration-status');
    expect(req.request.method).toBe('GET');
    req.flush({ enabled: true });
  });
});
