import { Injectable } from '@angular/core';
import type { MediaMetadataInit } from '../lib/media-metadata';
import { getCapacitorPlugin, isIosNative, isNativePlatform } from '../lib/platform';
import {
  pickArtworkUrl,
  toNativeMetadata,
  type NativeNowPlayingMetadata,
} from '../lib/now-playing';

export type MediaAction =
  'play' | 'pause' | 'nexttrack' | 'previoustrack' | 'seekto' | 'seekforward' | 'seekbackward';

/** Called when the OS dispatches a media action; `seekTime` is set only for `seekto`. */
export type MediaActionHandler = (seekTime: number | null) => void;

/** A transport command forwarded from the native iOS lock-screen controls. */
export interface RemoteCommandEvent {
  action: MediaAction;
  /** Present only for `seekto`. */
  seekTime?: number;
}

/** Snapshot of the native iOS plugin's runtime state (on-device diagnostics). */
export interface NowPlayingDiagnostics {
  pluginRegistered: boolean;
  sessionConfigured: boolean;
  audioCategory: string;
  isOtherAudioPlaying: boolean;
  commandsRegistered: boolean;
  nowPlayingInfoKeys: string[];
  artworkUrl: string;
  lastArtworkStatus: string;
}

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

/** The native iOS `NicotindNowPlaying` plugin surface (MPNowPlayingInfoCenter). */
interface IosNowPlayingPlugin {
  setMetadata(o: NativeNowPlayingMetadata): Promise<void>;
  setPlaybackState(o: { state: 'playing' | 'paused' | 'none' }): Promise<void>;
  setPositionState(o: { duration: number; position: number; playbackRate: number }): Promise<void>;
  clear(): Promise<void>;
  /** Lock-screen transport commands (play/pause/next/prev/seek) bridged to JS. */
  addListener?(
    event: 'remoteCommand',
    cb: (e: RemoteCommandEvent) => void,
  ): Promise<{ remove(): void }>;
  getDiagnostics?(): Promise<NowPlayingDiagnostics>;
}

/**
 * Bridges the app's playback to the OS media session (lock-screen / notification
 * controls + hardware keys).
 *
 * - **Android / web** use `@jofr/capacitor-media-session`. On Android the plugin
 *   runs a media-playback foreground service so audio keeps playing when the app
 *   is backgrounded; on web it wraps the Web Media Session API. (The Android
 *   WebView does not support the Web API, which is why a plugin is required for
 *   system controls to appear at all.)
 * - **iOS** is special: `@jofr` ships no iOS native code, so there it just
 *   proxies WKWebView's Web Media Session — which wires play/pause to the audio
 *   element but does **not** surface JS-set metadata/artwork/position. So the
 *   *displayed info* (title/artist/album/artwork/duration/elapsed) **and the
 *   transport controls** are routed to the native
 *   `@nicotind/capacitor-now-playing` plugin: it owns the AVAudioSession +
 *   MPRemoteCommandCenter, so it both shows the card and forwards lock-screen
 *   play/pause/next/seek back via a `remoteCommand` event. Because the native
 *   plugin owns the commands, iOS **must not** also wire WKWebView's
 *   `setActionHandler` (that would fire every transport action twice). If the
 *   native plugin is unavailable we fall back to `@jofr` for info (no
 *   regression); transport just no-ops until the plugin ships. See
 *   docs/ios-app.md "iOS Now Playing".
 *
 * The `@jofr` plugin is **lazily imported** so unit tests and the initial web
 * chunk don't pull in Capacitor; every call is best-effort (a browser without
 * media-session support just no-ops). See docs/mobile-app.md "Background audio".
 */
@Injectable({ providedIn: 'root' })
export class MediaControlsService {
  // Wrapped in a plain `{ session }` box rather than holding the proxy directly:
  // the `@jofr` `MediaSession` is a Capacitor plugin proxy that intercepts *every*
  // property get (including `.then`) as a native call. If a Promise ever resolves
  // to the bare proxy, the Promise machinery probes `value.then` to check for
  // thenable-ness, which the proxy turns into a `MediaSession.then()` call that
  // rejects with UNIMPLEMENTED on web — surfacing as an uncaught rejection in the
  // console. Boxing it keeps the proxy off the resolution path. // why
  private api?: Promise<{ session: MediaSessionApi } | null>;
  private iosPlugin?: IosNowPlayingPlugin | null;
  /** iOS transport handlers keyed by action; dispatched from one `remoteCommand` listener. */
  private readonly iosHandlers = new Map<MediaAction, MediaActionHandler>();
  private iosListenerAttached = false;

  /** The native iOS Now Playing plugin when running on iOS, else null (memoized). */
  private iosNowPlaying(): IosNowPlayingPlugin | null {
    if (this.iosPlugin === undefined) {
      this.iosPlugin = isIosNative()
        ? getCapacitorPlugin<IosNowPlayingPlugin>('NicotindNowPlaying')
        : null;
    }
    return this.iosPlugin;
  }

  private session(): Promise<{ session: MediaSessionApi } | null> {
    return (this.api ??= import('@jofr/capacitor-media-session')
      .then((m) => ({ session: m.MediaSession as unknown as MediaSessionApi }))
      .catch(() => null));
  }

  private run(fn: (s: MediaSessionApi) => Promise<unknown>): void {
    this.session()
      .then((w) => (w ? fn(w.session) : undefined))
      .catch(() => {
        /* media session unsupported — ignore */
      });
  }

  setMetadata(meta: MediaMetadataInit): void {
    const ios = this.iosNowPlaying();
    if (ios) {
      ios.setMetadata(toNativeMetadata(meta)).catch(() => {
        /* best-effort */
      });
      return;
    }

    // Android/Web: guard against an unreachable cover URL killing the app. The
    // @jofr plugin fetches the URL on the Capacitor thread via Java's
    // HttpURLConnection; anything it throws (404 -> FileNotFoundException,
    // connection failure -> IOException) propagates as a FATAL EXCEPTION and
    // the process dies — at launch, before the WebView ever appears, since
    // metadata for the restored track is set during startup (issue #441).
    if (!meta.artwork || meta.artwork.length === 0) {
      this.run((s) => s.setMetadata(meta));
      return;
    }

    // Set metadata without artwork immediately so controls stay responsive.
    this.run((s) => s.setMetadata({ ...meta, artwork: [] }));

    const probeUrl = pickArtworkUrl(meta.artwork);
    if (!probeUrl) return;

    // `fetch` with `cache: 'no-store'`, not `new Image()`. An <img> load can be
    // served from the WebView's HTTP cache without touching the network, so it
    // proved nothing about whether Java — a different client, on a different
    // thread, with a different cache — could reach the server. That mismatch is
    // what still crashed the app after the original 404 guard: cover in cache,
    // server gone. Forcing a real request makes the probe predictive, and it
    // covers the offline case for free (the fetch simply fails).
    //
    // Probes the same URL the plugin will actually use (the largest, via the
    // shared `pickArtworkUrl`) rather than `artwork[0]`, which was a different
    // image than the one being validated.
    //
    // Residual: the network can still die between probe and native fetch. That
    // window can't be closed from here — a plugin that crashes its host on any
    // artwork failure is the real defect (see #226, which replaces it).
    // `no-store` only where a stale-cache false positive can actually kill the
    // app. On web a failed cover just doesn't render, so bypassing the HTTP
    // cache there would mean an extra full-size cover request on every track
    // change and buy nothing.
    void fetch(probeUrl, isNativePlatform() ? { cache: 'no-store' } : {})
      .then((res) => {
        if (res.ok) this.run((s) => s.setMetadata(meta));
      })
      .catch(() => {
        /* leave the controls art-less rather than risk killing the app */
      });
  }

  setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    const ios = this.iosNowPlaying();
    if (ios) {
      ios.setPlaybackState({ state }).catch(() => {
        /* best-effort */
      });
      return;
    }
    this.run((s) => s.setPlaybackState({ playbackState: state }));
  }

  setPositionState(duration: number, position: number): void {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
    const ios = this.iosNowPlaying();
    if (ios) {
      ios.setPositionState({ duration, position, playbackRate: 1 }).catch(() => {
        /* best-effort */
      });
      return;
    }
    this.run((s) => s.setPositionState({ duration, position, playbackRate: 1 }));
  }

  setActionHandler(action: MediaAction, handler: MediaActionHandler): void {
    const ios = this.iosNowPlaying();
    if (ios) {
      // Native plugin owns the lock-screen commands; route through its single
      // `remoteCommand` event and do NOT also wire @jofr (would double-fire).
      this.iosHandlers.set(action, handler);
      if (!this.iosListenerAttached && ios.addListener) {
        this.iosListenerAttached = true;
        ios
          .addListener('remoteCommand', (e) => {
            const h = this.iosHandlers.get(e.action);
            if (h) h(e.action === 'seekto' ? (e.seekTime ?? null) : null);
          })
          .catch(() => {
            this.iosListenerAttached = false;
          });
      }
      return;
    }
    this.run((s) => s.setActionHandler({ action }, (d) => handler(d?.seekTime ?? null)));
  }

  /** Native iOS plugin diagnostics for the on-device debug panel; null elsewhere. */
  async getDiagnostics(): Promise<NowPlayingDiagnostics | null> {
    const ios = this.iosNowPlaying();
    if (!ios?.getDiagnostics) return null;
    try {
      return await ios.getDiagnostics();
    } catch {
      return null;
    }
  }
}
