import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors, HttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { authInterceptor } from './auth.interceptor';
import { SetupService } from '../services/setup.service';

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
