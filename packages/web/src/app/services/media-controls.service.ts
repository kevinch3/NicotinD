import { Injectable } from '@angular/core';
import type { MediaMetadataInit } from '../lib/media-metadata';

export type MediaAction =
  | 'play'
  | 'pause'
  | 'nexttrack'
  | 'previoustrack'
  | 'seekto'
  | 'seekforward'
  | 'seekbackward';

/** Called when the OS dispatches a media action; `seekTime` is set only for `seekto`. */
export type MediaActionHandler = (seekTime: number | null) => void;

// Minimal shape of the @jofr/capacitor-media-session `MediaSession` object we use.
interface MediaSessionApi {
  setMetadata(o: MediaMetadataInit): Promise<void>;
  setPlaybackState(o: { playbackState: 'playing' | 'paused' | 'none' }): Promise<void>;
  setPositionState(o: { duration: number; position: number; playbackRate: number }): Promise<void>;
  setActionHandler(
    o: { action: MediaAction },
    handler: ((d: { seekTime: number | null }) => void) | null,
  ): Promise<void>;
}

/**
 * Bridges the app's playback to the OS media session (lock-screen / notification
 * controls + hardware keys) via `@jofr/capacitor-media-session`. On Android the
 * plugin runs a media-playback foreground service so audio keeps playing when the
 * app is backgrounded; on web/iOS it is a thin wrapper over the Web Media Session
 * API. The Android WebView does **not** support the Web API, which is why a plugin
 * is required for system controls to appear at all.
 *
 * The plugin is **lazily imported** so unit tests and the initial web chunk don't
 * pull in Capacitor; every call is best-effort (a browser without media-session
 * support just no-ops). See docs/mobile-app.md "Background audio".
 */
@Injectable({ providedIn: 'root' })
export class MediaControlsService {
  private api?: Promise<MediaSessionApi | null>;

  private session(): Promise<MediaSessionApi | null> {
    return (this.api ??= import('@jofr/capacitor-media-session')
      .then((m) => m.MediaSession as unknown as MediaSessionApi)
      .catch(() => null));
  }

  private run(fn: (s: MediaSessionApi) => Promise<unknown>): void {
    this.session()
      .then((s) => (s ? fn(s) : undefined))
      .catch(() => {
        /* media session unsupported — ignore */
      });
  }

  setMetadata(meta: MediaMetadataInit): void {
    this.run((s) => s.setMetadata(meta));
  }

  setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    this.run((s) => s.setPlaybackState({ playbackState: state }));
  }

  setPositionState(duration: number, position: number): void {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
    this.run((s) => s.setPositionState({ duration, position, playbackRate: 1 }));
  }

  setActionHandler(action: MediaAction, handler: MediaActionHandler): void {
    this.run((s) => s.setActionHandler({ action }, (d) => handler(d?.seekTime ?? null)));
  }
}
