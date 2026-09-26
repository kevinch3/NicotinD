import { Injectable, InjectionToken, effect, inject, signal, untracked } from '@angular/core';
import { isTvBuild } from '../lib/platform';
import { ProfileCastListener, type ProfileCastListenerOptions } from '../lib/profile-cast-listener';
import { AuthService } from './auth.service';
import { PlaybackWsService } from './playback-ws.service';
import { RemotePlaybackService } from './remote-playback.service';
import { ServerConfigService } from './server-config.service';
import { TvProfileService } from './tv-profile.service';

interface Listener {
  start(): void;
  stop(): void;
  update(fields: { activated?: boolean }): void;
}

export const PROFILE_CAST_LISTENER_FACTORY = new InjectionToken<
  (opts: ProfileCastListenerOptions) => Listener
>('PROFILE_CAST_LISTENER_FACTORY', {
  providedIn: 'root',
  factory: () => (opts) => new ProfileCastListener(opts),
});

/** A listener that gave up is confirmed dead or retried after this long. */
export const LISTENER_RETRY_MS = 30_000;

interface OpenListener {
  username: string;
  listener: Listener;
}

/**
 * Casting to a shared TV as whoever you are (#1406). One listener per stored
 * person who is not active, so every member of the household sees the TV in
 * their phone's picker; a cast switches the TV to the caster.
 *
 * The server drops a device only when the LAST socket holding its id for that
 * user closes, and dropping the active device ends the session. So the
 * caster's listener stays open until the main socket has re-registered as them
 * (`syncedAs`), and only then closes; a new listener for anyone else opens only
 * once `syncedAs === active`, and at boot nobody gets one before that.
 *
 * The ordering alone does not end the outgoing person's session: their main
 * socket's close starts the server's 15 s grace, and their listener's REGISTER
 * of the same id cancels it. Two releases do: `resetSession` (which every
 * switch runs) releases this TV's output while the socket is still open, and
 * a listener whose registration echo still names this TV releases it — the
 * belt for a session the reset could not reach, e.g. a reboot (not for the
 * person being switched TO — that echo may be their fresh cast).
 *
 * Listeners are keyed by server, person and token: a server switch or a new
 * token stops the old line and opens a fresh one.
 */
@Injectable({ providedIn: 'root' })
export class TvProfileListenerService {
  private readonly profiles = inject(TvProfileService);
  private readonly remote = inject(RemotePlaybackService);
  private readonly auth = inject(AuthService);
  private readonly ws = inject(PlaybackWsService);
  private readonly server = inject(ServerConfigService);
  private readonly create = inject(PROFILE_CAST_LISTENER_FACTORY);

  private readonly open = new Map<string, OpenListener>();
  /** Keys whose listener gave up on an unconfirmed outage, waiting to retry. */
  private readonly cooling = new Set<string>();
  private readonly retryTick = signal(0);
  private readonly listeningSig = signal<string[]>([]);
  readonly listening = this.listeningSig.asReadonly();

  constructor() {
    if (!isTvBuild()) return;

    effect(() => {
      const on = this.remote.outputAvailable() && !!this.auth.token();
      const active = this.auth.username();
      const syncedAs = this.remote.syncedAs();
      const stale = this.profiles.stale();
      const people = this.profiles.profiles();
      const server = this.server.baseUrl();
      this.retryTick();
      untracked(() => {
        const wanted = new Map<string, { username: string; token: string }>();
        if (on) {
          for (const p of people) {
            if (stale.has(p.username)) continue;
            const key = `${server}|${p.username}|${p.token}`;
            if (this.cooling.has(key)) continue;
            const entry = { username: p.username, token: p.token };
            if (p.username === active) {
              // Never open one for the active person; keep an existing one
              // until the server has acknowledged the main socket as them.
              if (this.open.has(key) && syncedAs !== active) wanted.set(key, entry);
              continue;
            }
            // A brand-new listener waits for the main socket to have caught
            // up with whoever is active; an already-open one for someone
            // else stays open regardless (it isn't part of this hand-over).
            if (this.open.has(key) || syncedAs === active) wanted.set(key, entry);
          }
        }
        for (const [key, { listener }] of this.open) {
          if (!wanted.has(key)) {
            listener.stop();
            this.open.delete(key);
          }
        }
        for (const [key, { username, token }] of wanted) {
          if (this.open.has(key)) continue;
          const listener = this.create({
            url: this.server.wsUrl(`/api/ws/playback?token=${encodeURIComponent(token)}`),
            registration: () => ({
              id: this.ws.getDeviceId(),
              name: this.ws.getDeviceName(),
              remoteEnabled: true,
              activated: this.ws.isActivated(),
            }),
            onCast: () => void this.profiles.switchTo(username, { landing: '/player' }),
            onRefused: () => void this.refused(key, username, token),
            releaseStaleOutput: () => this.auth.username() !== username,
          });
          this.open.set(key, { username, listener });
          listener.start();
        }
        this.publish();
      });
    });

    // The server will not target a device that has had no user gesture; the
    // main socket reports its first one, the listeners must too.
    effect(() => {
      if (!this.ws.activation()) return;
      untracked(() => {
        for (const { listener } of this.open.values()) listener.update({ activated: true });
      });
    });
  }

  /** Five failed opens: a dead token, or just the server or Wi-Fi being down.
   *  A raw fetch tells them apart — never HttpClient, whose interceptor signs
   *  the ACTIVE person out on any 401 (#1410). */
  private async refused(key: string, username: string, token: string): Promise<void> {
    const entry = this.open.get(key);
    if (entry) {
      entry.listener.stop();
      this.open.delete(key);
    }
    this.cooling.add(key);
    this.publish();
    let status: number | null = null;
    try {
      const res = await fetch(this.server.apiUrl('/api/auth/me'), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch {
      // unreachable or hung: retry below
    }
    // The server or the person's token changed while in flight: this answer
    // is about a line nobody wants any more.
    if (this.currentKey(username) !== key) {
      this.cooling.delete(key);
      return;
    }
    if (status === 401 || status === 403) {
      this.cooling.delete(key);
      this.profiles.markStale(username);
      return;
    }
    setTimeout(() => {
      this.cooling.delete(key);
      this.retryTick.update((n) => n + 1);
    }, LISTENER_RETRY_MS);
  }

  private currentKey(username: string): string | null {
    const p = this.profiles.profiles().find((x) => x.username === username);
    return p ? `${this.server.baseUrl()}|${username}|${p.token}` : null;
  }

  private publish(): void {
    this.listeningSig.set([...this.open.values()].map((e) => e.username));
  }
}
