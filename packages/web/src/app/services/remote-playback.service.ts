/**
 * RemotePlaybackService
 *
 * Merges the Zustand remote-playback store and the RemotePlaybackProvider into
 * a single Angular service. Owns all remote-playback state (as signals) and
 * wires up WebSocket subscriptions + reactive effects in `initialize()`.
 *
 * Call `initialize()` once at app bootstrap (e.g. in AppComponent constructor).
 */
import { Injectable, inject, signal, computed, effect, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { PlaybackWsService } from './playback-ws.service';
import { PlayerService, Track } from './player.service';
import { AuthService } from './auth.service';

export interface RemoteDevice {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
}

@Injectable({ providedIn: 'root' })
export class RemotePlaybackService {
  private readonly ws = inject(PlaybackWsService);
  private readonly player = inject(PlayerService);
  private readonly auth = inject(AuthService);

  // ---------------------------------------------------------------------------
  // State signals
  // ---------------------------------------------------------------------------

  /** Whether this client has opted in to receive remote play commands */
  readonly remoteEnabled = signal(
    localStorage.getItem('nicotind_remote_enabled') === 'true',
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
  readonly isActiveDevice = computed(() => {
    const active = this.activeDeviceId();
    const myId = this.ws.getDeviceId();
    return !active || active === myId;
  });

  // ---------------------------------------------------------------------------
  // Internal bookkeeping
  // ---------------------------------------------------------------------------

  private lateJoinApplied = false;
  private lastRemoteTrackId: string | null = null;
  private subscriptions: Subscription[] = [];
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

  switchToDevice(id: string): void {
    this.ws.setActiveDevice(id);
    // Sync whatever track the controller is currently playing to the target device
    const currentTrack = this.player.currentTrack();
    if (currentTrack) {
      this.ws.sendCommand('SET_TRACK', { track: currentTrack });
    }
    // Optimistically update
    this.activeDeviceId.set(id);
  }

  // ---------------------------------------------------------------------------
  // Initialization -- call once at app bootstrap
  // ---------------------------------------------------------------------------

  initialize(): void {
    this.teardown();

    const myId = this.ws.getDeviceId();

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
      const activeDeviceId = this.activeDeviceId();
      const isActive = !activeDeviceId || activeDeviceId === myId;
      const trackId = currentTrack?.id ?? null;

      // Skip if no track or track hasn't actually changed
      if (!currentTrack || trackId === this.previousTrackId) {
        this.previousTrackId = trackId;
        return;
      }
      this.previousTrackId = trackId;

      // Scenario A: Controller picks a new song -> send SET_TRACK to the active device.
      // Echo protection: skip if this track was just applied from an incoming COMMAND/STATE_SYNC.
      if (!isActive) {
        if (currentTrack.id !== this.lastRemoteTrackId) {
          this.ws.sendCommand('SET_TRACK', { track: currentTrack });
        }
        return;
      }

      // Scenario B: Active device changes track locally -> push metadata to server
      // so controllers see the new song info immediately.
      this.ws.sendStateUpdate({
        track: currentTrack,
        trackId: currentTrack.id,
        isPlaying: true,
        position: 0,
      });
    });

    // --- Subscribe to STATE_SYNC ---
    this.subscriptions.push(
      this.ws
        .messages<{
          state: {
            activeDeviceId?: string | null;
            isPlaying?: boolean;
            track?: Track | null;
            position?: number;
            duration?: number;
          };
          devices?: RemoteDevice[];
        }>('STATE_SYNC')
        .subscribe((payload) => {
          const { state, devices } = payload;

          if (state?.activeDeviceId !== undefined) {
            this.activeDeviceId.set(state.activeDeviceId ?? null);
          }
          if (devices) this.devices.set(devices);

          // Keep the controller's UI in sync with the remote device's playing state
          if (state?.isPlaying !== undefined) {
            this.remoteIsPlaying.set(state.isPlaying);
          }

          // Sync remote progress for seek bar interpolation on controller.
          // Prefer actual audio duration from PROGRESS_REPORT over track metadata.
          if (state?.position !== undefined) {
            const dur = state?.duration ?? state?.track?.duration ?? 0;
            this.setRemoteProgress(state.position, dur);
          }

          const amActive = state?.activeDeviceId === myId;
          const remoteEnabled = this.remoteEnabled();

          // Late-join: if this device is already the active device when it first connects
          // and the server has a track stored, load it now. Only runs ONCE.
          if (amActive && state?.track && !this.lateJoinApplied) {
            this.lateJoinApplied = true;
            if (remoteEnabled) {
              this.player.play(state.track);
              if (state.isPlaying === false) this.player.pause();
            }
          }

          // Controller: sync remote track metadata so the player bar shows current info.
          // Uses setCurrentTrackMetadata to avoid clearing queue/history or loading audio.
          // Only applies when a proper remote session exists and this device has opted in.
          const hasActiveSession = typeof state?.activeDeviceId === 'string';
          if (!amActive && hasActiveSession && remoteEnabled && state?.track) {
            const localTrack = this.player.currentTrack();
            if (state.track.id !== localTrack?.id) {
              this.lastRemoteTrackId = state.track.id;
              this.player.setCurrentTrackMetadata(state.track);
            }
          }
        }),
    );

    // --- Subscribe to DEVICES_SYNC ---
    this.subscriptions.push(
      this.ws
        .messages<{ devices: RemoteDevice[] }>('DEVICES_SYNC')
        .subscribe((payload) => {
          this.devices.set(payload.devices);
        }),
    );

    // --- Subscribe to COMMAND ---
    // Only executed on the active, opted-in device. PLAY/PAUSE/SEEK/SET_TRACK
    // are all routed through COMMAND (not STATE_SYNC) to avoid echo loops.
    this.subscriptions.push(
      this.ws
        .messages<{ action: string; track?: Track; position?: number }>('COMMAND')
        .subscribe((payload) => {
          // Re-check at call time to avoid race during device switch
          const currentActiveId = this.activeDeviceId();
          if (currentActiveId !== myId) return;
          const remoteEnabled = this.remoteEnabled();
          if (!remoteEnabled) return;

          const { action } = payload;
          if (action === 'PLAY') this.player.resume();
          if (action === 'PAUSE') this.player.pause();
          if (action === 'SEEK' && payload.position !== undefined) {
            this.player.seek(payload.position);
          }
          if (action === 'SET_TRACK' && payload.track) {
            this.lastRemoteTrackId = payload.track.id;
            this.player.play(payload.track);
          }
          if (action === 'NEXT') this.player.playNext();
          if (action === 'PREV') this.player.playPrev();
        }),
    );
  }

  private teardown(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.subscriptions = [];
  }
}
