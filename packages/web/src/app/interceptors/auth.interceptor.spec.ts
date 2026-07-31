import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors, HttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import { authInterceptor } from './auth.interceptor';
import { SetupService } from '../services/setup.service';
import { AuthService } from '../services/auth.service';

/**
 * The interceptor is the mid-session "server became unreachable" sensor: a
 * network-level failure (status 0 — no HTTP response at all) on an API path is
 * reported to SetupService, which verification-probes before switching the app
 * into offline mode. These specs pin down what is (and is NOT) a report.
 */
describe('authInterceptor — server-failure reporting', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let setup: { reportServerFailure: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    setup = { reportServerFailure: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: SetupService, useValue: setup as unknown as SetupService },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => ctrl.verify());

  it('reports a status-0 network failure on an API path', () => {
    http.get('/api/library/songs').subscribe({ error: () => {} });
    ctrl.expectOne('/api/library/songs').error(new ProgressEvent('error'));

    expect(setup.reportServerFailure).toHaveBeenCalledTimes(1);
  });

  it('does NOT report when the server answered with an HTTP error (it is reachable)', () => {
    http.get('/api/library/songs').subscribe({ error: () => {} });
    ctrl
      .expectOne('/api/library/songs')
      .flush({ error: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    expect(setup.reportServerFailure).not.toHaveBeenCalled();
  });

  it('does NOT report a network failure on a non-API path (e.g. an i18n catalog)', () => {
    http.get('/i18n/en.json').subscribe({ error: () => {} });
    ctrl.expectOne('/i18n/en.json').error(new ProgressEvent('error'));

    expect(setup.reportServerFailure).not.toHaveBeenCalled();
  });
});

describe('authInterceptor — 403 ACCOUNT_DISABLED forces logout (issue #337)', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: { logout: ReturnType<typeof vi.fn>; token: () => string | null };
  let router: { navigateByUrl: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auth = { logout: vi.fn(), token: () => null };
    router = { navigateByUrl: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        {
          provide: SetupService,
          useValue: { reportServerFailure: vi.fn() } as unknown as SetupService,
        },
        { provide: AuthService, useValue: auth as unknown as AuthService },
        { provide: Router, useValue: router as unknown as Router },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => ctrl.verify());

  it('logs out on the stable `code`, not the (possibly-localized) English message', () => {
    http.get('/api/library/songs').subscribe({ error: () => {} });
    ctrl
      .expectOne('/api/library/songs')
      .flush(
        { error: 'Account disabled', code: 'ACCOUNT_DISABLED' },
        { status: 403, statusText: 'Forbidden' },
      );

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/login');
  });

  it('does NOT log out on an unrelated 403 (e.g. a curator-only route)', () => {
    http.get('/api/library/songs').subscribe({ error: () => {} });
    ctrl
      .expectOne('/api/library/songs')
      .flush(
        { error: 'Only administrators can manage shares', code: 'FORBIDDEN' },
        { status: 403, statusText: 'Forbidden' },
      );

    expect(auth.logout).not.toHaveBeenCalled();
  });
});
