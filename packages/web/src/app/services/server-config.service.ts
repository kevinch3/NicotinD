import { Injectable, signal } from '@angular/core';
import { DEFAULT_SERVER_URL, normalizeServerUrl, buildApiUrl, buildWsUrl } from '../lib/server-url';
import { isNativePlatform } from '../lib/platform';

const STORAGE_KEY = 'nicotind_server_url';

/**
 * Holds the API base URL. On the web build this stays '' (same-origin, relative
 * paths — unchanged behavior). In the native (Capacitor) shell it defaults to the
 * canonical self-hosted server and is user-overridable via the server-picker
 * screen. `apiUrl()`/`wsUrl()` turn the app's relative `/api` paths absolute so
 * the bundled WebView app can reach a remote self-hosted server.
 */
@Injectable({ providedIn: 'root' })
export class ServerConfigService {
  readonly native = isNativePlatform();
  // Native first launch (no stored choice) seeds the canonical server so the app
  // is usable out of the box; the user can still change it on the picker screen.
  readonly baseUrl = signal<string>(
    localStorage.getItem(STORAGE_KEY) ?? (this.native ? DEFAULT_SERVER_URL : ''),
  );

  /** True when a server still needs to be chosen (native, nothing stored yet). */
  needsConfiguration(): boolean {
    return this.native && localStorage.getItem(STORAGE_KEY) === null;
  }

  setBaseUrl(input: string): string {
    const normalized = normalizeServerUrl(input);
    localStorage.setItem(STORAGE_KEY, normalized);
    this.baseUrl.set(normalized);
    return normalized;
  }

  /** Absolute URL for an `/api`/`/rest` path (no-op on web). */
  apiUrl(path: string): string {
    return buildApiUrl(this.baseUrl(), path);
  }

  /** Absolute ws(s) URL for an `/api/ws` path. */
  wsUrl(path: string): string {
    return buildWsUrl(this.baseUrl(), path, {
      protocol: window.location.protocol,
      host: window.location.host,
    });
  }

  /**
   * Absolute URL for streaming a track's audio bytes. Always appends
   * `ngsw-bypass` — the Angular service worker's `Driver.handleFetch()`
   * unconditionally intercepts every same-origin fetch (there's no configured
   * `dataGroup` to opt this path out of), and in Firefox specifically that
   * interception occasionally throws instead of falling through to a plain
   * network passthrough for a Range request, which surfaces as "ServiceWorker
   * intercepted the request and encountered an unexpected error" and a track
   * that never plays (intermittent — only some tracks hit it). `ngsw-bypass`
   * is Angular's own documented escape hatch: `onFetch()` returns immediately
   * without ever touching the SW driver when it sees this query param.
   */
  streamUrl(id: string, token: string | null): string {
    return this.apiUrl(`/api/stream/${id}?token=${token}&ngsw-bypass=1`);
  }
}
