import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors, HttpClient, HttpContext } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import { authInterceptor } from './auth.interceptor';
import { KEEP_SESSION_ON_401 } from '../lib/http-context';
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
  let setup: {
    reportServerFailure: ReturnType<typeof vi.fn>;
    reportServerSuccess: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    setup = { reportServerFailure: vi.fn(), reportServerSuccess: vi.fn() };
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

  it('reports a SUCCESSFUL API response so a recovered server heals offline mode (issue #372)', () => {
    http.get('/api/system/disk').subscribe();
    ctrl.expectOne('/api/system/disk').flush({ ok: true });

    expect(setup.reportServerSuccess).toHaveBeenCalledTimes(1);
    expect(setup.reportServerFailure).not.toHaveBeenCalled();
  });

  it('does NOT report success for a non-API request', () => {
    http.get('/i18n/en.json').subscribe();
    ctrl.expectOne('/i18n/en.json').flush({});

    expect(setup.reportServerSuccess).not.toHaveBeenCalled();
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

describe('authInterceptor — KEEP_SESSION_ON_401 (issue #1410)', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: { logout: ReturnType<typeof vi.fn>; token: () => string | null };
  let router: { navigateByUrl: ReturnType<typeof vi.fn> };
  const keep = () => new HttpContext().set(KEEP_SESSION_ON_401, true);

  beforeEach(() => {
    auth = { logout: vi.fn(), token: () => 'tok' };
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

  it('an ordinary 401 still logs out and goes to login', () => {
    http.post('/api/auth/refresh', {}).subscribe({ error: () => {} });
    ctrl.expectOne('/api/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/login');
  });

  it('a flagged 401 leaves the session alone — the caller handles it', () => {
    let status = 0;
    http
      .post('/api/auth/refresh', {}, { context: keep() })
      .subscribe({ error: (e: { status: number }) => (status = e.status) });
    ctrl.expectOne('/api/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(auth.logout).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    // The error still reaches the caller: it is the caller's decision now.
    expect(status).toBe(401);
  });

  it('a flagged ACCOUNT_DISABLED 403 leaves the session alone too', () => {
    http.get('/api/auth/me', { context: keep() }).subscribe({ error: () => {} });
    ctrl
      .expectOne('/api/auth/me')
      .flush(
        { error: 'Account disabled', code: 'ACCOUNT_DISABLED' },
        { status: 403, statusText: 'Forbidden' },
      );
    expect(auth.logout).not.toHaveBeenCalled();
  });
});
