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

/**
 * Casting to a shared TV as whoever you are (#1406). One listener per stored
 * person who is not active, so every member of the household sees the TV in
 * their phone's picker; a cast switches the TV to the caster.
 *
 * The hand-over order is the whole point: the server drops a device only when
 * the LAST socket holding its id for that user closes, and dropping the active
 * device ends the session. So the caster's listener stays open until the main
 * socket has re-registered as them (`syncedAs`), and only then closes.
 *
 * The other direction matters just as much: a NEW listener for anyone else
 * never opens while `syncedAs !== active`. Opening the outgoing person's
 * listener again immediately (same device id, their token) would race their
 * own main socket's teardown — if the listener's REGISTER won, the server
 * would never drop the TV from their session, so their phone would keep
 * showing "playing on TV" and a later cast from them would produce no
 * transition at all. Boot behaves the same way: nobody gets a listener until
 * the main socket's own registration is acknowledged.
 */
@Injectable({ providedIn: 'root' })
export class TvProfileListenerService {
  private readonly profiles = inject(TvProfileService);
  private readonly remote = inject(RemotePlaybackService);
  private readonly auth = inject(AuthService);
  private readonly ws = inject(PlaybackWsService);
  private readonly server = inject(ServerConfigService);
  private readonly create = inject(PROFILE_CAST_LISTENER_FACTORY);

  private readonly open = new Map<string, Listener>();
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
      untracked(() => {
        const wanted = new Map<string, string>(); // username → token
        if (on) {
          for (const p of people) {
            if (stale.has(p.username)) continue;
            if (p.username === active) {
              // Never open one for the active person; keep an existing one
              // until the server has acknowledged the main socket as them.
              if (this.open.has(p.username) && syncedAs !== active) wanted.set(p.username, p.token);
              continue;
            }
            // A brand-new listener waits for the main socket to have caught
            // up with whoever is active; an already-open one for someone
            // else stays open regardless (it isn't part of this hand-over).
            if (this.open.has(p.username) || syncedAs === active) wanted.set(p.username, p.token);
          }
        }
        for (const [username, listener] of this.open) {
          if (!wanted.has(username)) {
            listener.stop();
            this.open.delete(username);
          }
        }
        for (const [username, token] of wanted) {
          if (this.open.has(username)) continue;
          const listener = this.create({
            url: this.server.wsUrl(`/api/ws/playback?token=${encodeURIComponent(token)}`),
            registration: () => ({
              id: this.ws.getDeviceId(),
              name: this.ws.getDeviceName(),
              remoteEnabled: true,
              activated: this.ws.isActivated(),
            }),
            onCast: () => void this.profiles.switchTo(username, { landing: '/player' }),
            onRefused: () => this.profiles.markStale(username),
          });
          this.open.set(username, listener);
          listener.start();
        }
        this.listeningSig.set([...this.open.keys()]);
      });
    });

    // The server will not target a device that has had no user gesture; the
    // main socket reports its first one, the listeners must too.
    effect(() => {
      if (!this.ws.activation()) return;
      untracked(() => {
        for (const listener of this.open.values()) listener.update({ activated: true });
      });
    });
  }
}
