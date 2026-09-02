/**
 * PresenceService — reports this tab's presence to the server every 60s while
 * authenticated, so admins can see who is currently active. Best-effort: heartbeat
 * errors are swallowed (the auth interceptor already handles 401/403 logout).
 *
 * deviceId is shared with the playback WS; since #882 it embeds this same tabId,
 * both resolved through the one `resolveTabId` helper so the two reports can never
 * disagree about which tab they describe. See docs/presence-tracking.md.
 */
import { Injectable, inject, effect } from '@angular/core';
import { AuthService } from './auth.service';
import { PlaybackWsService } from './playback-ws.service';
import { SystemApiService } from './api/system-api.service';
import { profileIdOf, resolveTabId } from '../lib/device-id';

const HEARTBEAT_INTERVAL = 60_000;

@Injectable({ providedIn: 'root' })
export class PresenceService {
  private auth = inject(AuthService);
  private ws = inject(PlaybackWsService);
  private api = inject(SystemApiService);

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tabId = resolveTabId(sessionStorage);

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
    // The playback device id is per-TAB since #882; presence counts machines
    // (`amountOfDevices` is a set of deviceId), so it reports the profile half
    // — otherwise three tabs on one laptop read as three devices in Admin.
    this.api
      .postHeartbeat(profileIdOf(this.ws.getDeviceId()), this.tabId)
      .subscribe({ error: () => {} });
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
