/**
 * RemotePlaybackService
 *
 * Owns the remote-playback session state as signals and wires the WebSocket
 * subscriptions + reactive effects in `initialize()`. Every protocol decision
 * — who is the audio output, what a frame does to the player, what a local
 * track change sends — lives in the pure `@nicotind/core` reducer; this
 * service is the adapter that feeds it signals and applies its effects to
 * `PlayerService`. The api-side multi-device simulation drives that same
 * reducer against the real server, which is what keeps it honest (#877).
 *
 * Call `initialize()` once at app bootstrap (e.g. in AppComponent constructor).
 */
import { Injectable, inject, signal, computed, effect, untracked, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  castTo,
  isAudioOutput,
  onLocalTrackChanged,
  reduceServerMessage,
  type ClientMessage,
  type PlayerEffect,
  type RemoteClientContext,
  type RemoteClientState,
  type RemoteDevice,
  type ServerMessage,
} from '@nicotind/core';
import { PlaybackWsService } from './playback-ws.service';
import { PlayerService, Track } from './player.service';
import { AuthService } from './auth.service';
import { isTvBuild, resolveTvDefaultedPreference } from '../lib/platform';

export type { RemoteDevice } from '@nicotind/core';

@Injectable({ providedIn: 'root' })
export class RemotePlaybackService {
  private readonly ws = inject(PlaybackWsService);
  private readonly player = inject(PlayerService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  // ---------------------------------------------------------------------------
  // State signals
  // ---------------------------------------------------------------------------

  /**
   * Whether this client has opted in to receive remote play commands.
   * Explicit user choice (the key exists in storage) always wins; only when
   * the user has never toggled this do we default it on for a TV build, so a
   * TV instance is immediately controllable from a phone with zero setup.
   */
  readonly remoteEnabled = signal(
    resolveTvDefaultedPreference(localStorage.getItem('nicotind_remote_enabled'), isTvBuild()),
  );
  /** Set when remote playback was automatically disabled due to connection failure */
  readonly disabledReason = signal<string | null>(null);
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

  // ---------------------------------------------------------------------------
  // Internal bookkeeping
  // ---------------------------------------------------------------------------

  private lastRemoteTrackId: string | null = null;
  private previousTrackId: string | null = null;

  // ---------------------------------------------------------------------------
  // Simple setters
  // ---------------------------------------------------------------------------

  setRemoteEnabled(enabled: boolean): void {
    if (enabled) {
      this.disabledReason.set(null);
      this.ws.clearPersistentFailure();
    }
    localStorage.setItem('nicotind_remote_enabled', String(enabled));
    this.ws.updateDevice({ remoteEnabled: enabled });
    this.remoteEnabled.set(enabled);
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
    };
  }

  private context(): RemoteClientContext {
    return {
      myId: this.ws.getDeviceId(),
      remoteEnabled: this.remoteEnabled(),
      localTrackId: this.player.currentTrack()?.id ?? null,
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
      }
    }
  }

  private post(messages: ClientMessage[]): void {
    for (const m of messages) {
      switch (m.type) {
        case 'SET_ACTIVE_DEVICE':
          this.ws.setActiveDevice(m.payload.id);
          break;
        case 'COMMAND':
          this.ws.sendCommand(m.payload.action, { track: m.payload.track });
          break;
        case 'STATE_UPDATE':
          this.ws.sendStateUpdate(m.payload.state);
          break;
      }
    }
  }

  private handle(msg: ServerMessage): void {
    const r = reduceServerMessage(this.snapshot(), this.context(), msg);
    this.commit(r.state);
    this.apply(r.effects);
  }

  // ---------------------------------------------------------------------------
  // Initialization -- call once at app bootstrap
  // ---------------------------------------------------------------------------

  initialize(): void {
    // --- Auth token effect: connect WS when token exists, disconnect when null ---
    effect(() => {
      const token = this.auth.token();
      const enabled = this.remoteEnabled();
      if (token && enabled) {
        this.ws.connect();
      } else {
        this.ws.disconnect();
      }
    });

    // --- Auto-disable when WS fails persistently ---
    effect(() => {
      const reason = this.ws.persistentFailure();
      const enabled = this.remoteEnabled();
      if (reason && enabled) {
        untracked(() => {
          this.setRemoteEnabled(false);
          this.disabledReason.set(reason);
        });
      }
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

      const { messages } = untracked(() =>
        onLocalTrackChanged(this.snapshot(), this.context(), currentTrack),
      );
      this.post(messages);
    });

    for (const type of ['STATE_SYNC', 'DEVICES_SYNC', 'COMMAND'] as const) {
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
    this.disabledReason.set(null);
    this.lastRemoteTrackId = null;
    this.previousTrackId = null;
  }
}
