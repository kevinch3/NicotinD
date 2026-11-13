/**
 * The static demo's wiring (docs/demo-mode.md), swapped in for `demo-config.ts`
 * by the `demo` build configuration. Nothing here reaches any other bundle.
 *
 * - every `/api` request is answered by `DemoServer` from the recorded snapshot
 *   (`demo-data/snapshot.json`, shipped beside the bundle) and never leaves the
 *   browser;
 * - the visitor is signed in before boot, as an admin, so every page is there
 *   to look at (writes that would change the server are refused);
 * - the live channels (library SSE, playback WebSocket) stay closed — polling
 *   carries the Get progress, as it does whenever SSE is down.
 */
import {
  Injectable,
  provideAppInitializer,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import {
  HttpErrorResponse,
  HttpResponse,
  type HttpEvent,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { LibraryEventsService } from '../services/library-events.service';
import { PlaybackWsService } from '../services/playback-ws.service';
import { DemoServer, type DemoSnapshot, type DemoState } from './demo-snapshot';

const STATE_KEY = 'nicotind_demo_state';

let server: Promise<DemoServer> | null = null;

function readState(): Partial<DemoState> {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? '{}') as Partial<DemoState>;
  } catch {
    return {};
  }
}

function writeState(state: DemoState): void {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Private mode: the demo simply forgets its Gets on reload.
  }
}

function demoServer(): Promise<DemoServer> {
  server ??= fetch('demo-data/snapshot.json')
    .then((res) => res.json() as Promise<DemoSnapshot>)
    .then((snapshot) => new DemoServer(snapshot, () => Date.now(), readState()));
  return server;
}

/** The URL path of an API request, whether the app built it relative or absolute. */
function apiPath(req: HttpRequest<unknown>): string | null {
  const url = req.urlWithParams;
  const at = url.indexOf('/api/');
  return at === -1 ? null : url.slice(at);
}

export const demoInterceptor: HttpInterceptorFn = (req, next) => {
  const path = apiPath(req);
  if (!path) return next(req);
  return from(
    demoServer().then((demo): HttpEvent<unknown> => {
      const res = demo.handle(req.method, path, req.body);
      writeState(demo.state());
      if (res.status >= 400) {
        throw new HttpErrorResponse({ status: res.status, error: res.body, url: req.url });
      }
      return new HttpResponse({ status: res.status, body: res.body, url: req.url });
    }),
  ) as Observable<HttpEvent<unknown>>;
};

@Injectable()
class DemoLibraryEventsService extends LibraryEventsService {
  override start(): void {}
}

@Injectable()
class DemoPlaybackWsService extends PlaybackWsService {
  override connect(): void {}
}

export const DEMO_INTERCEPTORS: HttpInterceptorFn[] = [demoInterceptor];

export const DEMO_PROVIDERS: Array<Provider | EnvironmentProviders> = [
  { provide: LibraryEventsService, useClass: DemoLibraryEventsService },
  { provide: PlaybackWsService, useClass: DemoPlaybackWsService },
  // The snapshot is fetched before boot so the first request does not wait.
  provideAppInitializer(() => demoServer().then(() => undefined)),
];

// A deep link or reload came back through the Pages 404 page
// (scripts/build-demo.ts): restore the path before the router reads it.
try {
  const redirect = sessionStorage.getItem('nicotind_demo_redirect');
  if (redirect !== null) {
    sessionStorage.removeItem('nicotind_demo_redirect');
    history.replaceState(null, '', new URL(redirect, document.baseURI).href);
  }
} catch {
  // Storage blocked: the visitor lands on Home instead of the deep link.
}

// At module evaluation, i.e. before bootstrap constructs AuthService (which
// seeds its signals from storage): the visitor lands signed in.
try {
  localStorage.setItem('nicotind_token', 'demo');
  localStorage.setItem('nicotind_username', 'demo');
  localStorage.setItem('nicotind_role', 'admin');
} catch {
  // Storage blocked: the visitor starts on the login page, where the snapshot
  // answers the login call.
}
