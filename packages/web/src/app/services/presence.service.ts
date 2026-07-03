/**
 * PresenceService — reports this tab's presence to the server every 60s while
 * authenticated, so admins can see who is currently active. Best-effort: heartbeat
 * errors are swallowed (the auth interceptor already handles 401/403 logout).
 *
 * deviceId is shared with the playback WS (same physical device); tabId is unique
 * per browser tab. See docs/presence-tracking.md.
 */
import { Injectable, inject, effect } from '@angular/core';
import { AuthService } from './auth.service';
import { PlaybackWsService } from './playback-ws.service';
import { SystemApiService } from './api/system-api.service';

const HEARTBEAT_INTERVAL = 60_000;

@Injectable({ providedIn: 'root' })
export class PresenceService {
  private auth = inject(AuthService);
  private ws = inject(PlaybackWsService);
  private api = inject(SystemApiService);

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tabId = this.resolveTabId();

  /** Call once at app bootstrap (from the root App component). */
  initialize(): void {
    // Start/refresh the heartbeat loop whenever auth state changes.
    effect(() => {
      const token = this.auth.token();
      this.stop();
      if (token) {
        this.send(); // immediate first report — don't wait 60s
        this.timer = setInterval(() => this.send(), HEARTBEAT_INTERVAL);
      }
    });
  }

  private send(): void {
    this.api.postHeartbeat(this.ws.getDeviceId(), this.tabId).subscribe({ error: () => {} });
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** A stable per-tab id in sessionStorage (mirrors PlaybackWsService's device-id fallback). */
  private resolveTabId(): string {
    const stored = sessionStorage.getItem('nicotind_tab_id');
    if (stored) return stored;

    let id: string;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      id =
        Array.from({ length: 16 }, () =>
          Math.floor(Math.random() * 256)
            .toString(16)
            .padStart(2, '0'),
        ).join('') +
        '-' +
        Date.now().toString(36);
    }

    sessionStorage.setItem('nicotind_tab_id', id);
    return id;
  }
}
