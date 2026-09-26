/**
 * RemotePlaybackService
 *
 * Owns the remote-playback session state as signals and wires the WebSocket
 * subscriptions + reactive effects in `initialize()`. Every protocol decision
 * — who is the audio output, what a frame does to the player, what a local
 * track change or play/pause sends — lives in the pure `@nicotind/core`
 * reducer; this service is the adapter that feeds it signals and applies its
 * effects to `PlayerService`. The api-side multi-device simulation drives that
 * same reducer against the real server, which is what keeps it honest (#877).
 *
 * The socket is the account's presence channel: it is open whenever the user
 * is logged in, regardless of the "available as an output" preference. That
 * preference only decides whether *other* devices may drive this one.
 *
 * Call `initialize()` once at app bootstrap (e.g. in AppComponent constructor).
 */
import {
  Injectable,
  Injector,
  inject,
  signal,
  computed,
  effect,
  untracked,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  castTo,
  hasControllableSession,
  isAudioOutput,
  onLocalPlayingChanged,
  onLocalQueueChanged,
  onLocalTrackChanged,
  reduceServerMessage,
  type ClientMessage,
  type PlayerEffect,
  type RemoteClientContext,
  type RemoteClientState,
  type RemoteDevice,
  type ServerMessage,
} from '@nicotind/core';
import {
  PlaybackWsService,
  OUTPUT_AVAILABLE_KEY,
  readOutputAvailable,
} from './playback-ws.service';
import { PlayerService, Track } from './player.service';
import { AuthService } from './auth.service';
import { LibraryApiService } from './api/library-api.service';
import { toTrack } from '../lib/track-utils';

export type { RemoteDevice } from '@nicotind/core';

@Injectable({ providedIn: 'root' })
export class RemotePlaybackService {
  private readonly ws = inject(PlaybackWsService);
  private readonly player = inject(PlayerService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  /** Resolving a session queue needs HTTP; fetched lazily so every consumer
   *  of this service does not have to provide it. */
  private readonly injector = inject(Injector);

  // ---------------------------------------------------------------------------
  // State signals
  // ---------------------------------------------------------------------------

  /** Whether the user's other devices may play music on this one: listed in
   *  their pickers and executing their commands. On by default everywhere;
   *  an explicit "false" in storage is the only way off. */
  readonly outputAvailable = signal(readOutputAvailable(localStorage));
  /** The device that is currently the active audio output */
  readonly activeDeviceId = signal<string | null>(null);
  /** All known connected devices */
  readonly devices = signal<RemoteDevice[]>([]);
  /** Whether the device switcher popover is open */
  readonly switcherOpen = signal(false);
  /** Reflects the remote device's isPlaying -- used by the controller's UI */
  readonly remoteIsPlaying = signal(false);
  /** Last known playback position (seconds) reported by the active device */
  readonly remotePosition = signal(0);
  /** Wall-clock ms when remotePosition was received -- for interpolation */
  readonly remotePositionTs = signal(0);
  /** Audio duration reported by the active device */
  readonly remoteDuration = signal(0);

  /** Whether this browser tab is the active audio output device */
  readonly isActiveDevice = computed(() =>
    isAudioOutput(this.activeDeviceId(), this.ws.getDeviceId()),
  );
  /** A session exists and names another device: show the chrome. */
  readonly playingElsewhere = computed(() => {
    const active = this.activeDeviceId();
    return active !== null && active !== this.ws.getDeviceId();
  });
  /** The device the session names, if it is in the list. */
  readonly activeDevice = computed(() => {
    const active = this.activeDeviceId();
    return active === null ? null : (this.devices().find((d) => d.id === active) ?? null);
  });
  /** The session's device can be driven from here; otherwise the transport is
   *  inert and a play or pick claims the output locally. */
  readonly sessionControllable = computed(() =>
    hasControllableSession({
      activeDeviceId: this.activeDeviceId(),
      devices: this.devices(),
      remoteIsPlaying: false,
      remotePosition: 0,
      remotePositionTs: 0,
      remoteDuration: 0,
      lastRemoteTrackId: null,
      sessionQueue: null,
    }),
  );
  /** A session exists and this device is part of it: its queue panel shows
   *  the session's one queue, not a private one (#895). */
  readonly sharedQueue = computed(() => {
    if (this.activeDeviceId() === null) return false;
    const me = this.ws.getDeviceId();
    return this.playingElsewhere() || this.devices().some((d) => d.id !== me);
  });
  /** Why the presence channel is down, when it stayed down. */
  readonly syncStatus = computed(() => this.ws.persistentFailure());

  /**
   * Bumped every time a **server message** made this device start playing —
   * i.e. a controller cast to it.
   *
   * Nothing derivable after the fact can tell a cast from a local play: a local
   * play claims the output too, so `isActiveDevice()` is true either way (and
   * `isAudioOutput` is true with no session at all). A receiver that wants to
   * show what it was just told to play — the TV routes to its player (#1128) —
   * needs the moment, not the state.
   */
  readonly castsReceived = signal(0);

  /** The person the presence socket was opened for. A TV profile switch changes
   *  the person without ever clearing the token in between (#1406). */
  private connectedUser: string | null = null;
  private readonly connectedAsSig = signal<string | null>(null);
  readonly connectedAs = this.connectedAsSig.asReadonly();
  /** The person the SERVER has acknowledged this device under: the registration
   *  reply has arrived on the live socket. The TV's cast listeners hand over on it. */
  readonly syncedAs = computed(() => (this.ws.synced() ? this.connectedAsSig() : null));

  // ---------------------------------------------------------------------------
  // Internal bookkeeping
  // ---------------------------------------------------------------------------

  private lastRemoteTrackId: string | null = null;
  private sessionQueue: string[] | null = null;
  /** Bumped per `set-queue`, so a slower resolution never overwrites a newer. */
  private queueGeneration = 0;
  private previousTrackId: string | null = null;
  private previousPlaying = false;
  /** A pick fires both the playing and the track effect; one claim is enough. */
  private claimInFlight: string | null = null;

  // ---------------------------------------------------------------------------
  // Simple setters
  // ---------------------------------------------------------------------------

  setOutputAvailable(enabled: boolean): void {
    localStorage.setItem(OUTPUT_AVAILABLE_KEY, String(enabled));
    this.ws.updateDevice({ remoteEnabled: enabled });
    this.outputAvailable.set(enabled);
  }

  setDevices(devices: RemoteDevice[]): void {
    this.devices.set(devices);
  }

  setActiveDeviceId(id: string | null): void {
    this.activeDeviceId.set(id);
  }

  setSwitcherOpen(open: boolean): void {
    this.switcherOpen.set(open);
  }

  setRemoteIsPlaying(playing: boolean): void {
    this.remoteIsPlaying.set(playing);
  }

  setRemoteProgress(position: number, duration: number): void {
    this.remotePosition.set(position);
    this.remotePositionTs.set(Date.now());
    this.remoteDuration.set(duration);
  }

  /** The user picked an output device in the switcher. */
  switchToDevice(id: string): void {
    const r = castTo(this.snapshot(), this.context(), id, this.player.currentTrack());
    this.post(r.messages);
    this.commit(r.state);
    this.apply(r.effects);
  }

  // ---------------------------------------------------------------------------
  // Reducer plumbing
  // ---------------------------------------------------------------------------

  private snapshot(): RemoteClientState {
    return {
      activeDeviceId: this.activeDeviceId(),
      devices: this.devices(),
      remoteIsPlaying: this.remoteIsPlaying(),
      remotePosition: this.remotePosition(),
      remotePositionTs: this.remotePositionTs(),
      remoteDuration: this.remoteDuration(),
      lastRemoteTrackId: this.lastRemoteTrackId,
      sessionQueue: this.sessionQueue,
    };
  }

  private context(): RemoteClientContext {
    return {
      myId: this.ws.getDeviceId(),
      remoteEnabled: this.outputAvailable(),
      localTrackId: this.player.currentTrack()?.id ?? null,
      localQueue: this.player.queue().map((t) => t.id),
      now: Date.now(),
    };
  }

  private commit(state: RemoteClientState): void {
    this.activeDeviceId.set(state.activeDeviceId);
    this.devices.set(state.devices);
    this.remoteIsPlaying.set(state.remoteIsPlaying);
    this.remotePosition.set(state.remotePosition);
    this.remotePositionTs.set(state.remotePositionTs);
    this.remoteDuration.set(state.remoteDuration);
    this.lastRemoteTrackId = state.lastRemoteTrackId;
    this.sessionQueue = state.sessionQueue;
  }

  private apply(effects: PlayerEffect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case 'play':
          this.player.play(e.track as Track);
          break;
        case 'resume':
          this.player.resume();
          break;
        case 'pause':
        case 'yield':
          this.player.pause();
          break;
        case 'seek':
          this.player.seek(e.position);
          break;
        case 'next':
          this.player.playNext();
          break;
        case 'prev':
          this.player.playPrev();
          break;
        case 'show-track':
          // Metadata only: no queue/history churn, no audio load.
          this.player.setCurrentTrackMetadata(e.track as Track);
          break;
        case 'resume-local':
          this.player.seek(e.position);
          if (e.playing) this.player.resume();
          else this.player.pause();
          break;
        case 'set-queue':
          this.adoptQueue(e.ids);
          break;
      }
    }
  }

  /**
   * Replace the local queue with the session's (#895). Ids this device already
   * holds a track for (queue, history, now playing) cost nothing; the rest are
   * fetched in one call. An id the library does not know is dropped — the
   * queue effect then reports the shorter list, so the other side sees it go.
   * A failed fetch applies nothing rather than a list with holes.
   */
  private adoptQueue(ids: string[]): void {
    const generation = ++this.queueGeneration;
    const known = new Map<string, Track>();
    const current = this.player.currentTrack();
    for (const t of [
      ...this.player.history(),
      ...(current ? [current] : []),
      ...this.player.queue(),
    ])
      known.set(t.id, t);
    const commit = () => {
      if (generation !== this.queueGeneration) return;
      this.player.setQueue(ids.flatMap((id) => known.get(id) ?? []));
    };
    const missing = [...new Set(ids.filter((id) => !known.has(id)))];
    if (missing.length === 0) {
      commit();
      return;
    }
    this.injector
      .get(LibraryApiService)
      .resolveSongs(missing)
      .subscribe({
        next: (songs) => {
          for (const song of songs) known.set(song.id, toTrack(song));
          commit();
        },
        error: () => undefined,
      });
  }

  private post(messages: ClientMessage[]): void {
    for (const m of messages) {
      switch (m.type) {
        case 'SET_ACTIVE_DEVICE':
          if (m.payload.queue) this.ws.setActiveDevice(m.payload.id, m.payload.queue);
          else this.ws.setActiveDevice(m.payload.id);
          break;
        case 'CLAIM_OUTPUT':
          if (this.claimInFlight === m.payload.trackId) break;
          this.claimInFlight = m.payload.trackId;
          this.ws.sendClaim(m.payload);
          break;
        case 'RELEASE_OUTPUT':
          this.ws.sendRelease();
          break;
        case 'COMMAND': {
          const { action, ...extra } = m.payload;
          this.ws.sendCommand(action, extra);
          break;
        }
        case 'STATE_UPDATE':
          this.ws.sendStateUpdate(m.payload.state);
          break;
      }
    }
  }

  private handle(msg: ServerMessage): void {
    if (msg.type === 'STATE_SYNC') this.claimInFlight = null;
    const r = reduceServerMessage(this.snapshot(), this.context(), msg);
    this.commit(r.state);
    this.apply(r.effects);
    // Only here, never in the local paths: `apply` is shared with
    // `switchToDevice`, and a pick made *on* this device is not a cast *to* it.
    // `show-track` is excluded deliberately — it is metadata for a controller,
    // which is the case where the audio is somewhere else.
    if (r.effects.some((e) => e.kind === 'play' || e.kind === 'resume')) {
      this.castsReceived.update((n) => n + 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization -- call once at app bootstrap
  // ---------------------------------------------------------------------------

  initialize(): void {
    // --- Presence channel: up whenever logged in, down on logout ---
    // Keyed on the person too, not only the token: a TV profile switch
    // (#1406) swaps one person's token for another's in a single tick, and
    // connect() alone no-ops on an open socket — the TV stayed registered as
    // the previous person, castable and drivable from their phone.
    effect(() => {
      const token = this.auth.token();
      const user = this.auth.username();
      untracked(() => {
        if (!token) {
          this.ws.disconnect();
          this.connectedUser = null;
          this.connectedAsSig.set(null);
          return;
        }
        if (this.connectedUser !== null && user !== this.connectedUser) {
          // The outgoing person's session must not stay on this device: a bare
          // close only starts the grace, and their cast listener re-registering
          // the same id inside it would keep the session alive (#1406).
          if (this.activeDeviceId() === this.ws.getDeviceId()) this.ws.sendRelease();
          this.ws.disconnect();
        }
        this.connectedUser = user;
        this.connectedAsSig.set(user);
        this.ws.connect();
      });
    });

    // A restored track is not a change: forwarding it would restart the
    // output's audio from a tab that merely reloaded (#882).
    this.previousTrackId = this.player.currentTrack()?.id ?? null;

    // Only the output tops a radio queue up: the queue is shared (#895).
    effect(() => this.player.radioTopUpHere.set(this.isActiveDevice()));

    // --- Queue forwarding (#895) ---
    // Registered before the track effect on purpose: an edit that also moves
    // the track (a jump, an album pick) must reach the server first, or the
    // track's broadcast would carry the old queue back to this controller.
    let firstQueueRun = true;
    effect(() => {
      const queue = this.player.queue().map((t) => t.id);
      // The restored queue is not an edit, like the restored track above.
      if (firstQueueRun) {
        firstQueueRun = false;
        return;
      }
      const r = untracked(() => onLocalQueueChanged(this.snapshot(), this.context(), queue));
      this.sessionQueue = r.state.sessionQueue;
      this.post(r.messages);
    });

    // --- Track change forwarding ---
    effect(() => {
      const currentTrack = this.player.currentTrack();
      const trackId = currentTrack?.id ?? null;

      // Skip if no track or track hasn't actually changed
      if (!currentTrack || trackId === this.previousTrackId) {
        this.previousTrackId = trackId;
        return;
      }
      this.previousTrackId = trackId;
      // Only a pick (which sets `isPlaying`) is a change worth telling the
      // session about; metadata restored or mirrored while paused is not.
      if (!untracked(() => this.player.isPlaying())) return;

      const { messages } = untracked(() =>
        onLocalTrackChanged(this.snapshot(), this.context(), currentTrack),
      );
      this.post(messages);
    });

    // --- Play/pause: the output reports it, a device with nothing to drive claims ---
    effect(() => {
      const playing = this.player.isPlaying();
      if (playing === this.previousPlaying) return;
      this.previousPlaying = playing;
      const { messages } = untracked(() =>
        onLocalPlayingChanged(
          this.snapshot(),
          this.context(),
          playing,
          this.player.currentTrack(),
          this.player.currentTime(),
        ),
      );
      this.post(messages);
    });

    // --- The first gesture makes this tab able to play on command ---
    const activate = () => {
      this.ws.markActivated();
    };
    for (const type of ['pointerdown', 'keydown'] as const) {
      document.addEventListener(type, activate, { once: true, capture: true, passive: true });
    }

    // --- A closing tab frees the session at once; the grace is for blips ---
    window.addEventListener('pagehide', () => {
      if (this.activeDeviceId() === this.ws.getDeviceId()) this.ws.sendRelease();
    });

    for (const type of ['STATE_SYNC', 'DEVICES_SYNC', 'COMMAND', 'PROGRESS'] as const) {
      this.ws
        .messages<ServerMessage['payload']>(type)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((payload) => this.handle({ type, payload } as ServerMessage));
    }
  }

  reset(): void {
    this.activeDeviceId.set(null);
    this.devices.set([]);
    this.remoteIsPlaying.set(false);
    this.remotePosition.set(0);
    this.remotePositionTs.set(0);
    this.remoteDuration.set(0);
    this.lastRemoteTrackId = null;
    this.sessionQueue = null;
    this.queueGeneration++;
    this.previousTrackId = null;
    this.previousPlaying = false;
    this.claimInFlight = null;
  }
}
