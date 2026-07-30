import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError, timeout } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ServerConfigService } from '../services/server-config.service';
import { SetupService } from '../services/setup.service';

// Read requests that hang against an unreachable host (common in the native
// WebView when connectivity drops) are bounded so they fail fast instead of
// lingering until the OS socket timeout. Scoped to GET only — mutating calls
// (rescans, bulk Lidarr re-fetches, uploads) can legitimately run much longer,
// so we must not abort those. HttpClient aborts the underlying XHR on the
// unsubscribe that `timeout` triggers, so there's no leaked request.
const GET_TIMEOUT_MS = 30_000;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const server = inject(ServerConfigService);
  const router = inject(Router);
  const setup = inject(SetupService);
  const token = auth.token();

  // Rewrite relative /api|/rest paths to the configured server (no-op on web,
  // where baseUrl is '' and same-origin relative paths are used as-is).
  const url = server.apiUrl(req.url);
  let outgoing = url !== req.url ? req.clone({ url }) : req;
  if (token && !outgoing.headers.has('Authorization')) {
    outgoing = outgoing.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  const bounded =
    outgoing.method === 'GET' ? next(outgoing).pipe(timeout(GET_TIMEOUT_MS)) : next(outgoing);

  return bounded.pipe(
    catchError((err: HttpErrorResponse) => {
      // A network-level failure (status 0 = the request died with no HTTP
      // response: server down, DNS/connection refused, dropped mid-flight) on an
      // API path is the mid-session "server became unreachable" signal. Report it
      // so the app can VERIFY and switch itself into offline mode — the report
      // triggers a single reachability probe rather than trusting one flaky
      // request (see SetupService.reportServerFailure). Any HTTP status ≥ 1
      // means the server answered, i.e. it is reachable — never reported.
      if (err.status === 0 && (req.url.startsWith('/api') || req.url.startsWith('/rest'))) {
        setup.reportServerFailure();
      }
      if (err.status === 401) {
        auth.logout();
        // Router (not window.location) — a hard navigation breaks in the native
        // WebView where there is no real server at the local origin root.
        router.navigateByUrl('/login');
      }
      if (err.status === 403) {
        const errorMsg = err.error?.error;
        if (errorMsg === 'Account disabled') {
          auth.logout();
          router.navigateByUrl('/login');
        }
      }
      return throwError(() => err);
    }),
  );
};
