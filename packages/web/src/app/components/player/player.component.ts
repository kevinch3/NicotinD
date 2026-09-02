import {
  Component,
  inject,
  signal,
  computed,
  effect,
  untracked,
  viewChild,
  ElementRef,
  OnDestroy,
  AfterViewInit,
  NgZone,
} from '@angular/core';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { LikeService } from '../../services/like.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../artist-links/artist-links.component';
import { DeviceSwitcherComponent } from '../device-switcher/device-switcher.component';
import { PreserveService } from '../../services/preserve.service';
import { ServerConfigService } from '../../services/server-config.service';
import { MediaControlsService } from '../../services/media-controls.service';
import { NetworkStatusService } from '../../services/network-status.service';
import { ToastService } from '../../services/toast.service';
import { buildMediaMetadata } from '../../lib/media-metadata';
import * as db from '../../lib/preserve-store';
import { createPointerDrag } from '../../lib/pointer-drag';
import { miniPlayerSlideClass } from '../../lib/player-chrome';
import {
  SEEK_AVAILABILITY_EPSILON_SEC,
  seekTargetIsAvailable,
  seekableEnd,
  timeRangesToArray,
} from '../../lib/seek-availability';
import { SeekBarComponent } from '../seek-bar/seek-bar.component';
import { TranslateService } from '../../services/translate.service';
import { ListeningTrackerService } from '../../services/listening-tracker.service';
import { VocalSeparationService } from '../../services/vocal-separation.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { PlayerTransportMiniComponent } from './player-transport-mini/player-transport-mini.component';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { isTvBuild } from '../../lib/platform';

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Absolute floor (seconds) used by both {@link browserDurationIsAcceptable}
 * and {@link PlayerComponent.isFalseEnded} when there is no API-known
 * `track.duration` to compare against (the library scanner writes
 * `duration: 0` when a file's tags carry no parseable duration — see
 * `library-scanner.ts` — and the API ships that through as 0/undefined).
 * Real tracks are essentially never this short, so a sub-floor native
 * duration is treated as a truncated/corrupt server response rather than a
 * legitimately tiny track (issue #234).
 */
export const FALSE_ENDED_ABSOLUTE_FLOOR_SEC = 3;

/**
 * How many false-ended recoveries one track load may attempt before the
 * player gives up and advances the queue.
 *
 * Without a bound the recovery is unterminating: `onEnded` re-enters
 * {@link PlayerComponent.startRecovery} on every false `ended`, and the 5 s
 * `recoveryTimeout` valve resets `recoveryState` to `'normal'` then reloads
 * and plays — so a genuinely short/corrupt resource ends early again and the
 * track restarts every ~5 s, forever, never reaching the next queue item.
 * After this many attempts the resource is treated as legitimately short and
 * the normal advance path runs.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * How long to wait before re-pointing the element at a stream the browser gave
 * up on.
 *
 * A media `error` almost always means the transfer died, not that the resource
 * is gone — a socket the network dropped, a connection the WebView could not
 * re-open while a page's request burst held every one it had, a server that
 * blinked. Retrying in the same tick would re-run straight into whatever is
 * still busy; a short pause costs the listener nothing and turns most of these
 * into an unnoticed hiccup.
 */
export const MEDIA_ERROR_RETRY_MS = 1_000;

/**
 * How long playback may make no progress at all before the stream is treated
 * as dead and reloaded.
 *
 * A dropped stream does NOT reliably raise `error`: the element frequently just
 * parks on `waiting`/`stalled` and never asks for another byte, which is the
 * silent half of "the music stopped" — the store still says playing, the
 * position is frozen, and nothing in the app ever retries. The threshold is
 * deliberately far above a slow first load (an HDD spin-up plus a server-side
 * transcode is seconds, not tens of seconds), so a legitimately slow load is
 * never mistaken for a dead one.
 */
export const STREAM_STALL_TIMEOUT_MS = 20_000;

/**
 * How long a burst of track changes is allowed to settle before the player
 * actually fetches anything.
 *
 * Navigation itself stays instant — `currentTrack`, the title, the artwork and
 * the seek bar update on every press. Only the byte-level load is deferred, so
 * hammering Next five times costs one stream request instead of five started
 * and aborted (each of which can spin an HDD and start server-side transcode
 * work), and the audio element is never asked to start and abandon four loads
 * in a row.
 *
 * Applied on the trailing edge only: the first change after a quiet period
 * loads immediately, so a single Next keeps today's latency. A burst collapses
 * into that leading load plus one more for wherever the user landed.
 */
export const LOAD_SETTLE_MS = 250;

/**
 * How long an unsatisfiable seek is held before the player gives up waiting
 * and lands the user as far forward as the element can actually go.
 *
 * The seekable region normally grows to cover the target within a second or
 * two (the browser issues a Range request for it). It may never get there —
 * a transcode the server never finishes, or a file genuinely shorter than its
 * tags claim — and without a valve the seek bar would sit on a spinner
 * forever, which is the failure mode {@link PlayerComponent.requestSeek} was
 * written to remove, not reproduce.
 */
export const PENDING_SEEK_TIMEOUT_MS = 10_000;

/**
 * Frontend duration gate. The API-known `track.duration` (from the library
 * scan / source-file tag metadata) is the reference of truth — a browser
 * reporting a much-smaller `audio.duration` for the same resource usually
 * means the container is still being parsed (VBR / chunked streaming) or the
 * response is genuinely short (a corrupt server cache, the reported bug).
 *
 * Reject the browser's value unless BOTH checks pass:
 *   - `native >= 0.7 × known` (catches a 1.8 s browser parse of a 240 s file)
 *   - `|native − known| <= 5 s` (catches a 200 s browser parse of a 240 s file
 *     — relative check passes, absolute catches it)
 *
 * When the known value is missing (`<= 0`), there's no reference to compare
 * against, but blindly trusting the browser (the old behavior) let a
 * corrupt/truncated response for an unscanned-duration track slip past this
 * gate entirely — issue #234. Fall back to the absolute floor instead.
 */
export function browserDurationIsAcceptable(knownSec: number, nativeSec: number): boolean {
  if (!Number.isFinite(nativeSec) || nativeSec <= 0) return false;
  if (!Number.isFinite(knownSec) || knownSec <= 0) {
    return nativeSec >= FALSE_ENDED_ABSOLUTE_FLOOR_SEC;
  }
  const relativeOk = nativeSec >= knownSec * 0.7;
  const absoluteOk = Math.abs(nativeSec - knownSec) <= 5;
  return relativeOk && absoluteOk;
}

@Component({
  selector: 'app-player',
  imports: [
    CoverArtComponent,
    DeviceSwitcherComponent,
    SeekBarComponent,
    ArtistLinksComponent,
    TranslatePipe,
    PlayerTransportMiniComponent,
    TvNavItemDirective,
  ],
  templateUrl: './player.component.html',
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  /** TV renders the player as a route, so this component contributes only its
   *  <audio> engine there — no bar, and critically no seek bar (a native range
   *  input a remote cannot escape, issue #438). Build-time, not the DOM class:
   *  see app.routes.ts for why that distinction bites. */
  readonly isTv = isTvBuild();

  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  readonly likes = inject(LikeService);
  readonly remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private zone = inject(NgZone);
  private preserve = inject(PreserveService);
  private server = inject(ServerConfigService);
  private mediaControls = inject(MediaControlsService);
  private network = inject(NetworkStatusService);
  private toast = inject(ToastService);
  private i18n = inject(TranslateService);
  private tracker = inject(ListeningTrackerService);
  private vocalSep = inject(VocalSeparationService);

  private audioElA = viewChild<ElementRef<HTMLAudioElement>>('audioElA');
  private audioElB = viewChild<ElementRef<HTMLAudioElement>>('audioElB');
  // Which element is currently active; flipping this makes all Effects switch to the other element.
  private primaryIsA = signal(true);
  private readonly audioEl = computed(() =>
    this.primaryIsA() ? this.audioElA() : this.audioElB(),
  );
  private get standbyNativeEl(): HTMLAudioElement | null {
    return (this.primaryIsA() ? this.audioElB() : this.audioElA())?.nativeElement ?? null;
  }

  private pausingByStore = false;
  private backgroundPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private progressReportInterval: ReturnType<typeof setInterval> | null = null;
  private rafId: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  private wasPlayingBeforeHidden = false;
  private resumePendingAfterVisible = false;
  // Set by onEnded when it pre-loads the next track synchronously; tells Effect 1 to skip.
  private lastManualSrc: string | null = null;
  // Object URL created by onEnded for a preserved track; needs manual revocation.
  private lastManualObjectUrl: string | null = null;
  // Track id that has been pre-buffered into the standby element.
  private preloadedTrackId: string | null = null;
  // Tracks the last vocal mute state to detect toggle changes (Effect 6b).
  private lastVocalsMuted: boolean | null = null;
  // Load generation: bumped on every resource change — an in-place `audio.src`
  // reassignment (always via `assignSource`) as well as the onEnded standby
  // swap. Every event handler closure captures the generation at bind time and
  // ignores events from a prior resource's listener scope.
  //
  // It used to be bumped only on the cross-element swap, on the grounds that
  // the browser discards queued events when `src` is reassigned on the same
  // element. That covers *events*, but not the `play()` promises already in
  // flight, and rapid Next presses produce a pile of them — so the guard is
  // applied uniformly now. Bumping requires re-binding (handlers compare
  // against the captured value), which is why `assignSource` does both.
  private loadGeneration = 0;
  // Timestamp of the last committed load, for the LOAD_SETTLE_MS burst gate.
  private lastLoadCommitAt = 0;
  // True while a load is waiting out the settle window. Read by Effect 5,
  // which must not start the outgoing resource during that gap.
  private loadDeferred = false;
  // The track id the load path last acted on, so an Effect 1 re-run that is
  // *not* a track change (a token refresh) doesn't void an in-flight seek.
  private loadedTrackId: string | null = null;

  // Playback progress interpolation
  private interpolatedTime = signal(0);

  readonly isActiveDevice = this.remote.isActiveDevice;

  readonly slideClass = computed(() => miniPlayerSlideClass(this.player.currentTrack() !== null));

  readonly displayTime = computed(() => {
    if (!this.isActiveDevice()) return this.interpolatedTime();
    // A seek waiting on data shows its target, not the position the element is
    // still playing from: the user asked to be at 3:00, so the bar reads 3:00
    // while the bytes are fetched. Guarded on track id — a skip during the
    // wait leaves the intent stale until the applier collects it.
    const pending = this.player.pendingSeek();
    if (pending && pending.trackId === this.player.currentTrack()?.id) return pending.time;
    return this.player.currentTime();
  });

  readonly displayDuration = computed(() => {
    if (this.isActiveDevice()) return this.player.duration();
    return this.remote.remoteDuration() || this.player.duration();
  });

  readonly safeDuration = computed(() => {
    const d = this.displayDuration();
    return Number.isFinite(d) && d > 0 ? d : 0;
  });

  readonly safeProgress = computed(() => {
    const t = this.displayTime();
    const d = this.safeDuration();
    // When the duration is unknown/0 (mid-load, or false-ended recovery before
    // a real duration lands), don't fall back to `t` — that paints a 100% seek
    // bar from the first sample. Hold at 0 and let the real duration push the
    // bar to the right position once it arrives.
    if (!Number.isFinite(t) || t < 0) return 0;
    if (!Number.isFinite(d) || d <= 0) return 0;
    return Math.min(t, d);
  });

  readonly showPlaying = computed(() => {
    return this.isActiveDevice() ? this.player.isPlaying() : this.remote.remoteIsPlaying();
  });

  readonly showBuffering = computed(() => this.isActiveDevice() && this.player.bufferingVisible());

  // Event listener teardown references
  private audioListenerCleanups: (() => void)[] = [];

  constructor() {
    // Effect 1: Load track (checks IndexedDB first for offline-preserved tracks)
    effect((onCleanup) => {
      // Revoke any object URL we created in onEnded for a preserved track.
      const pendingObjectUrl = this.lastManualObjectUrl;
      this.lastManualObjectUrl = null;
      onCleanup(() => {
        if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
      });

      const track = this.player.currentTrack();
      const token = this.auth.token();
      const isActive = this.isActiveDevice();
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;
      // Cleared on every run; only the deferring branch below sets it again, so
      // it can never outlive the settle window it describes.
      this.loadDeferred = false;

      // Listening history: this device only. A controller tab mirroring a remote
      // device gets its `currentTrack` set by RemotePlaybackService without any
      // audio here, and counting that would double-count the real player's play.
      // Runs before the pre-load early return below, since that path is a track
      // genuinely starting. `isTracking` keeps a token refresh (which re-runs
      // this effect) from restarting the session; repeat-one restarts itself
      // explicitly in onEnded.
      if (isActive) {
        if (track && !this.tracker.isTracking(track.id)) {
          this.tracker.start(track, this.listeningSource());
        } else if (!track) {
          this.tracker.end('stopped');
        }
      }

      // A genuine track change voids any seek still waiting on data — the
      // target meant nothing outside the track it was made against. Keyed on
      // the id rather than "this effect ran" because a token refresh re-runs
      // the effect with the same track and must not cancel the user's seek.
      if ((track?.id ?? null) !== this.loadedTrackId) {
        this.loadedTrackId = track?.id ?? null;
        this.clearPendingSeek();
      }

      // onEnded pre-loaded this track synchronously to keep the Android audio session alive.
      if (track && this.lastManualSrc === track.id) {
        this.lastManualSrc = null;
        this.lastLoadCommitAt = Date.now();
        return;
      }

      let objectUrl: string | null = null;
      onCleanup(() => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });

      if (!isActive || !track) {
        this.teardownAudio(audio);
        if (!track) {
          this.player.setCurrentTime(0);
          this.player.setDuration(0);
        }
        return;
      }

      // ── Instant acknowledgement ───────────────────────────────────────────
      // Never deferred: the store-side state behind the title, artwork, seek
      // bar and row indicators has to land on every press, or a burst of skips
      // looks frozen while the settle window runs.
      //
      // Different audio — a fresh MAX_RECOVERY_ATTEMPTS allowance. Deliberately
      // NOT reset when a recovery succeeds: that's the same resource, and
      // refreshing its budget there lets a flaky one recover indefinitely.
      this.recoveryAttempts = 0;
      this.retryOnReconnect = false;
      this.recoveringStream = false;
      this.player.setCurrentTime(0);
      this.player.setDuration(track.duration ?? 0);
      // New load beginning — flag it before any bytes move so track rows and
      // play buttons can acknowledge instantly (HDD loads take seconds).
      this.player.setBuffering(true);
      this.player.setBufferedRanges([]);

      const commit = () => {
        this.lastLoadCommitAt = Date.now();
        this.loadDeferred = false;

        if (untracked(() => this.preserve.isPreserved(track.id))) {
          // Load from IndexedDB — no network request
          void (async () => {
            const blob = await db.getBlob(track.id);
            if (blob) {
              objectUrl = URL.createObjectURL(blob.audio);
              this.assignSource(audio, objectUrl);
              db.updateLastAccessed(track.id);
            } else {
              // Metadata exists but blob missing — fall back to stream
              this.assignSource(audio, this.streamSrc(track.id, token));
            }
            // Don't autoplay on a fresh track load: the user must have pressed
            // play (or have autoplay_on_load + restored session — which routes
            // through Effect 5 via isPlaying). Otherwise just loading the
            // metadata is enough — the seek position is restored by onDuration.
            this.playIfIntended(audio);
          })();
        } else if (untracked(() => !this.network.online())) {
          // Offline and this track isn't downloaded — don't point <audio> at an
          // unreachable stream. Left unguarded, the element stalls on a spinner
          // that never resolves (`onError` only clears buffering). Bail cleanly.
          this.stopForOffline(audio, track.title);
        } else {
          this.assignSource(audio, this.streamSrc(track.id, token));
          // See the preserve branch above for why play() is gated here.
          this.playIfIntended(audio);
        }
      };

      // ── Skip-burst collapsing ─────────────────────────────────────────────
      // Leading edge: the first change after a quiet period loads at once, so
      // a single Next is as fast as it ever was.
      const sinceLastCommit = Date.now() - this.lastLoadCommitAt;
      if (sinceLastCommit >= LOAD_SETTLE_MS) {
        commit();
        return;
      }
      // Trailing edge: silence the outgoing track for the settle window (the
      // user has already left it) and let the burst land on one load. Paused
      // through `pausingByStore` so onPause doesn't commit a store-level pause.
      this.loadDeferred = true;
      this.pausingByStore = true;
      audio.pause();
      this.pausingByStore = false;
      const timer = setTimeout(commit, LOAD_SETTLE_MS - sinceLastCommit);
      onCleanup(() => clearTimeout(timer));
    });

    // Effect 2: Media Session metadata (OS lock-screen / notification). Routed
    // through MediaControlsService so it works in the native WebView (which lacks
    // the Web Media Session API) as well as the browser.
    effect(() => {
      const track = this.player.currentTrack();
      const token = this.auth.token();

      if (!track) {
        this.mediaControls.setMetadata({ title: '', artist: '', album: '', artwork: [] });
        this.mediaControls.setPlaybackState('none');
        return;
      }

      this.mediaControls.setMetadata(
        buildMediaMetadata(track, (coverArt, size) =>
          this.server.apiUrl(`/api/cover/${coverArt}?size=${size}&token=${token}`),
        ),
      );
    });

    // Effect 3: Media Session playback state
    effect(() => {
      const playing = this.player.isPlaying();
      this.mediaControls.setPlaybackState(playing ? 'playing' : 'paused');
    });

    // Effect 4: Media Session action handlers
    // Handlers are always registered (never nulled) so OS controls work throughout the last
    // track and across lock-screen sessions. All callbacks run inside zone.run() because
    // lock-screen/notification-shade dispatches fire outside Angular's zone.
    effect(() => {
      // Read signals so effect re-runs when these change (keeps handlers fresh).
      this.player.queue();
      this.player.history();
      this.player.repeat();

      this.mediaControls.setActionHandler('play', () => this.zone.run(() => this.player.resume()));
      this.mediaControls.setActionHandler('pause', () => this.zone.run(() => this.player.pause()));
      this.mediaControls.setActionHandler('nexttrack', () =>
        this.zone.run(() => this.player.playNext()),
      );
      this.mediaControls.setActionHandler('previoustrack', () =>
        this.zone.run(() => {
          const audio = this.audioEl()?.nativeElement;
          if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
          } else {
            this.player.playPrev();
          }
        }),
      );
      this.mediaControls.setActionHandler('seekto', (seekTime) => {
        if (seekTime != null) this.zone.run(() => this.player.seek(seekTime));
      });
      this.mediaControls.setActionHandler('seekforward', () =>
        this.zone.run(() => this.player.seek(this.player.currentTime() + 10)),
      );
      this.mediaControls.setActionHandler('seekbackward', () =>
        this.zone.run(() => this.player.seek(Math.max(0, this.player.currentTime() - 10))),
      );
    });

    // Effect 5: Play/pause sync
    effect(() => {
      const playing = this.player.isPlaying();
      const isActive = this.isActiveDevice();
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

      if (!isActive) {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        this.releaseWakeLock();
        return;
      }
      if (playing) {
        // While a load waits out the settle window the element still holds the
        // *outgoing* resource, so playing here would briefly resume the track
        // the user just skipped away from. The deferred commit's
        // `playIfIntended` starts the incoming one instead.
        if (!this.loadDeferred) {
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.handlePlayRejection();
          });
        }
        void this.acquireWakeLock();
      } else {
        this.pausingByStore = true;
        audio.pause();
        this.pausingByStore = false;
        this.releaseWakeLock();
      }
    });

    // Effect 6: Seek from store. Every seek funnels through `player.seekTo` —
    // the seek bar (via onSeek), the OS media-session handlers, and anything
    // else calling `player.seek()` — so there is exactly one place that turns
    // a request into a media-element operation. It records an *intent* rather
    // than poking `currentTime` directly: see requestSeek for why a forward
    // seek past the loaded region must wait instead of being clamped.
    effect(() => {
      const seekTo = this.player.seekTo();
      const audio = this.audioEl()?.nativeElement;
      if (!audio || seekTo === null) return;
      this.player.clearSeek();
      this.requestSeek(audio, seekTo);
    });

    // Effect 6b: Vocal mute toggle — reloads the stream with/without the
    // ?vocals=off param. The toggle requires a fresh audio src because the
    // server-side filter produces a different file. Position is preserved via
    // player.restoredTime, which the existing onDuration handler (above)
    // applies once loadedmetadata fires on the new audio. This re-uses the
    // same restore mechanism as the page-reload path (PlayerService.restoreState).
    // why backend (not a client Web Audio graph): routing the <audio> element
    // through a MediaElementAudioSourceNode silenced playback entirely on
    // Android, so vocal removal must stay server-side. Do not reintroduce a
    // client-side vocal filter.
    // Keyed on "should the current track be served vocals-off", not on the
    // mute flag itself (issue #603): the flag is intent, and the URL flips when
    // the ML stem lands (or immediately, on a basic-only instance). Either
    // transition is the same in-place src swap with the position restored.
    effect(() => {
      const vocalsOff = this.vocalSep.currentServeVocalsOff();
      const track = this.player.currentTrack();
      const audio = this.audioEl()?.nativeElement;
      if (!track || !audio) return;

      // Skip the initial run (track load is handled by Effect 1).
      if (this.lastVocalsMuted === null) {
        this.lastVocalsMuted = vocalsOff;
        return;
      }
      if (vocalsOff === this.lastVocalsMuted) return;
      this.lastVocalsMuted = vocalsOff;

      // Stash the current position so onDuration restores it once the new
      // media's loadedmetadata fires (browser resets currentTime to 0 when
      // audio.src changes).
      if (audio.currentTime > 1) this.player.restoredTime = audio.currentTime;
      const wasPlaying = this.player.isPlaying();
      const token = this.auth.token();
      // A different resource: fresh recovery allowance, and the spinner up
      // front — the first encode of a stem is a couple of seconds, and the
      // 250 ms visibility delay hides it when the entry is already cached.
      this.recoveryAttempts = 0;
      this.player.setBuffering(true);
      this.player.setBufferedRanges([]);
      this.assignSource(audio, this.server.streamUrl(track.id, token, { vocalsOff }));
      if (wasPlaying) {
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
      }
    });

    // Effect 7: Progress reporting interval
    effect((onCleanup) => {
      const isActive = this.isActiveDevice();
      const playing = this.player.isPlaying();

      if (!isActive || !playing) return;
      const audio = this.audioEl()?.nativeElement;
      if (!audio) return;

      const report = () => {
        if (audio.duration > 0 && Number.isFinite(audio.currentTime)) {
          this.ws.sendProgressReport(audio.currentTime, audio.duration);
          // Keep the OS notification scrubber in sync (and enable seekto).
          this.mediaControls.setPositionState(audio.duration, audio.currentTime);
        }
      };

      report();
      const interval = setInterval(report, 2000);
      onCleanup(() => clearInterval(interval));
    });

    // Effect 8: Remote playback interpolation (rAF loop)
    effect((onCleanup) => {
      const isActive = this.isActiveDevice();

      if (isActive) {
        this.interpolatedTime.set(this.player.currentTime());
        return;
      }

      const remPlaying = this.remote.remoteIsPlaying();
      const remPos = this.remote.remotePosition();
      const remPosTs = this.remote.remotePositionTs();
      const remDur = this.remote.remoteDuration();

      if (!remPlaying) {
        this.interpolatedTime.set(remPos);
        return;
      }

      let rafId: number;
      const tick = () => {
        const elapsed = (Date.now() - remPosTs) / 1000;
        const maxTime = remDur || Infinity;
        this.interpolatedTime.set(Math.min(remPos + elapsed, maxTime));
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
      onCleanup(() => cancelAnimationFrame(rafId));
    });

    // Effect 9: resume a stream the network killed, the moment it comes back.
    //
    // Reads the monotonic `reconnects` counter as well as `online`, for the
    // reason NetworkStatusService documents: signals coalesce, so a fast
    // offline→online pair (a lift, a tunnel, a cell handover — the everyday
    // failure this recovery is for) leaves `online` looking unchanged and the
    // edge invisible.
    effect(() => {
      this.network.reconnects();
      const online = this.network.online();
      const audio = this.audioEl()?.nativeElement;
      if (!online || !audio || !this.retryOnReconnect) return;
      this.retryOnReconnect = false;
      untracked(() => this.recoverFromDeadStream(audio, this.loadGeneration));
    });
  }

  private handlePlayRejection(): void {
    this.player.setBuffering(false);
    if (document.visibilityState === 'hidden') {
      // Browser revoked autoplay while screen is locked — resume when app returns.
      this.resumePendingAfterVisible = true;
    } else {
      // No dedicated "tap to resume" banner (removed — it was a rarely-hit,
      // easy-to-break vestige of a stricter autoplay policy, and the Now
      // Playing sheet's copy of it grabbed the wrong <audio> element via
      // `document.querySelector('audio')`, so tapping it silently did
      // nothing). Just fall back to paused: the normal Play button is a
      // fresh user gesture and will succeed.
      this.player.pause();
    }
  }

  /**
   * Stream URL for a track load, carrying the karaoke mute. Every load path
   * (fresh track, gapless standby + swap, recovery reloads) goes through here
   * so the mute persists across tracks in the audio, not just in the signal
   * (issue #889). Whether THIS track is served vocals-off right now is the
   * separation service's call (issue #603): the mute is intent, and a track
   * whose ML stem is still preparing plays the original until it lands.
   * `untracked` because the load effects must not re-run on a toggle —
   * Effect 6b owns that transition.
   */
  private streamSrc(trackId: string, token: string | null = this.auth.token()): string {
    return this.server.streamUrl(trackId, token, {
      vocalsOff: untracked(() => this.vocalSep.shouldServeVocalsOff(trackId)),
    });
  }

  /**
   * Point the active element at a new resource.
   *
   * The generation bump plus re-bind is the whole point: handlers compare the
   * generation they captured at bind time against the current one, so bumping
   * without re-binding would silence the element permanently. Every in-place
   * `src` assignment goes through here so that an aborted load — the four
   * discarded ones in a five-press skip burst, above all — cannot land a
   * `play()` resolution or a late event on the resource that replaced it.
   */
  private assignSource(audio: HTMLAudioElement, src: string): void {
    this.loadGeneration += 1;
    this.bindAudioListeners(audio);
    audio.src = src;
  }

  /**
   * Start playback only if the user actually asked for it. An `AbortError`
   * from a load this one superseded is expected and ignored — only a revoked
   * autoplay permission needs handling.
   */
  private playIfIntended(audio: HTMLAudioElement): void {
    if (!untracked(() => this.player.isPlaying())) return;
    audio.play().catch((err) => {
      if (err.name === 'NotAllowedError') this.handlePlayRejection();
    });
  }

  /** Park the element with no resource: remote device took over, or queue empty. */
  private teardownAudio(audio: HTMLAudioElement): void {
    this.pausingByStore = true;
    audio.pause();
    this.pausingByStore = false;
    this.clearMediaRetryTimeout();
    this.clearStallTimeout();
    this.retryOnReconnect = false;
    this.recoveringStream = false;
    this.assignSource(audio, '');
    // Assigning an empty src raises `error` on the element: mark the parked
    // generation so dead-stream recovery ignores it (see `parkedGeneration`).
    this.parkedGeneration = this.loadGeneration;
    this.player.setBuffering(false);
    this.player.setBufferedRanges([]);
  }

  /**
   * Stop playback cleanly when the current/next track can't be sourced offline
   * (not downloaded, or its blob is missing). Avoids the silent, infinite
   * buffering spinner that a doomed network `<audio>` load would produce.
   */
  private stopForOffline(audio: HTMLAudioElement, title: string): void {
    this.teardownAudio(audio);
    this.toast.show({
      message: this.i18n.t('player.unavailableOffline', { title }),
      kind: 'error',
    });
  }

  /** The timer bounding how long an unsatisfiable seek is held. */
  private pendingSeekTimeout: ReturnType<typeof setTimeout> | null = null;

  private clearPendingSeekTimeout(): void {
    if (this.pendingSeekTimeout !== null) {
      clearTimeout(this.pendingSeekTimeout);
      this.pendingSeekTimeout = null;
    }
  }

  /** Drop the outstanding seek intent and its valve. Leaves buffering alone —
   *  callers know whether the seek resolved or was abandoned. */
  private clearPendingSeek(): void {
    this.clearPendingSeekTimeout();
    if (untracked(() => this.player.pendingSeek()) !== null) this.player.pendingSeek.set(null);
  }

  /** The outstanding seek target for the track that is current *now*, or null. */
  private pendingSeekTarget(): number | null {
    const pending = untracked(() => this.player.pendingSeek());
    if (!pending) return null;
    if (pending.trackId !== untracked(() => this.player.currentTrack())?.id) return null;
    return pending.time;
  }

  /**
   * Turn a seek request into an intent and apply it as soon as the element can
   * reach it.
   *
   * Assigning `currentTime` past the seekable region does not fail — the
   * browser clamps to the end of what it holds and fires `ended`, which the
   * rest of the player reads as "track finished". On a stream still filling
   * (an HDD read, a transcode in progress, a VBR container mid-parse) that
   * turned a forward seek into a 5 s freeze followed by the track restarting
   * at 0, because the false-ended recovery took over. So: record the target,
   * apply it the moment `audio.seekable` covers it, and let
   * {@link PENDING_SEEK_TIMEOUT_MS} bound the wait.
   */
  private requestSeek(audio: HTMLAudioElement, time: number): void {
    const track = untracked(() => this.player.currentTrack());
    if (!track) return;
    // Clamp to the duration the player believes in — the seek bar can't exceed
    // it, but `seekto` from an OS media control can.
    const known = untracked(() => this.player.duration());
    const target = Math.max(0, known > 0 ? Math.min(time, known) : time);

    this.player.pendingSeek.set({ trackId: track.id, time: target });
    this.clearPendingSeekTimeout();
    this.pendingSeekTimeout = setTimeout(() => {
      this.pendingSeekTimeout = null;
      this.forcePendingSeek();
    }, PENDING_SEEK_TIMEOUT_MS);

    this.applyPendingSeek(audio);
  }

  /**
   * Can the element be sent to `target` without silently clamping?
   *
   * Normally that means the target sits inside a seekable range. The second
   * clause covers the case the first one gets wrong: when the element can
   * already reach the end of the track, the whole resource is seekable and
   * nothing is going to clamp — so a deliberate drag to the last second is a
   * seek to the end, not a target to sit and wait on.
   */
  private seekTargetReachable(audio: HTMLAudioElement, target: number): boolean {
    const ranges = timeRangesToArray(audio.seekable);
    if (seekTargetIsAvailable(target, ranges)) return true;
    const known = untracked(() => this.player.duration());
    return known > 0 && seekableEnd(ranges) >= known - SEEK_AVAILABILITY_EPSILON_SEC;
  }

  /**
   * Apply the outstanding seek if the element can satisfy it, otherwise hold.
   * Called on every signal that the seekable region may have grown:
   * `durationchange`/`loadedmetadata`, `progress` and `canplay`.
   */
  private applyPendingSeek(audio: HTMLAudioElement): void {
    const target = this.pendingSeekTarget();
    if (target === null) {
      // Either nothing pending, or it belonged to a track we have since left.
      this.clearPendingSeek();
      return;
    }
    if (!this.seekTargetReachable(audio, target)) {
      // Not reachable yet. Keep the intent, keep the spinner up, and let the
      // next growth event (or the valve) resolve it.
      this.player.setBuffering(true);
      return;
    }
    this.clearPendingSeek();
    audio.currentTime = target;
  }

  /**
   * The valve: stop waiting and land as far forward as the element can go.
   * Better than stranding the user on a spinner when the seekable region is
   * never going to reach the target.
   */
  private forcePendingSeek(): void {
    const target = this.pendingSeekTarget();
    const audio = this.audioEl()?.nativeElement;
    this.clearPendingSeek();
    this.player.setBuffering(false);
    if (target === null || !audio) return;
    const reachable =
      seekableEnd(timeRangesToArray(audio.seekable)) - SEEK_AVAILABILITY_EPSILON_SEC;
    const landing = Math.min(target, reachable);
    if (landing > 0) audio.currentTime = landing;
  }

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotSupportedError' || err.name === 'NotAllowedError')
      )
        return;
      throw err;
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release();
    this.wakeLock = null;
  }

  ngAfterViewInit(): void {
    const audio = this.audioEl()?.nativeElement;
    if (!audio) return;
    this.bindAudioListeners(audio);

    this.visibilityChangeHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.wasPlayingBeforeHidden = this.player.isPlaying() && this.isActiveDevice();
      } else if (document.visibilityState === 'visible') {
        void this.acquireWakeLock();
        if (
          (this.wasPlayingBeforeHidden || this.resumePendingAfterVisible) &&
          this.isActiveDevice()
        ) {
          this.wasPlayingBeforeHidden = false;
          this.resumePendingAfterVisible = false;
          const audioEl = this.audioEl()?.nativeElement;
          if (audioEl) {
            if (!this.player.isPlaying()) this.player.resume();
            if (audioEl.paused) {
              audioEl.play().catch(() => this.player.pause());
            }
          }
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  private bindAudioListeners(audio: HTMLAudioElement): void {
    // Remove previous listeners before re-binding (called again on every element swap).
    this.audioListenerCleanups.forEach((fn) => fn());
    if (this.backgroundPauseTimer !== null) {
      clearTimeout(this.backgroundPauseTimer);
      this.backgroundPauseTimer = null;
    }
    // The stall watchdog belongs to the load being replaced. (The reload timer
    // does not: it is the one thing that legitimately outlives its own bind,
    // and it carries its own generation check.)
    this.clearStallTimeout();

    // Capture the load generation at bind time. Every handler below closes
    // over this number and bails if `loadGeneration` has moved on (the standby
    // element was swapped in, a vocal-mute toggle reloaded src, a skip
    // replaced the stream). Without this, a stale `ended` from the superseded
    // load could advance the queue right after the user picked a track.
    const boundGen = this.loadGeneration;

    const onTime = () => {
      if (boundGen !== this.loadGeneration) return;
      const value = audio.currentTime;
      // The clock advancing is proof the stream is alive; disarm the watchdog
      // rather than let it fire against a load that merely started slowly.
      if (this.stallTimeout !== null && value > this.stallWatchFrom + 0.5) this.clearStallTimeout();
      if (Number.isFinite(value) && value >= 0) {
        this.player.setCurrentTime(value);
        this.tracker.progress(value);
        if ('mediaSession' in navigator && audio.duration > 0 && Number.isFinite(audio.duration)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: audio.duration,
              playbackRate: 1,
              position: value,
            });
          } catch {
            // Older WebKit may throw
          }
        }
      }
      // Pre-buffer next track when 30 s remain so the element swap at onEnded is instant.
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const remaining = audio.duration - value;
        if (remaining > 0 && remaining < 30) {
          const nextTrack = untracked(() => this.player.queue()[0]);
          if (nextTrack && nextTrack.id !== this.preloadedTrackId) {
            const isPreserved = untracked(() => this.preserve.isPreserved(nextTrack.id));
            if (!isPreserved) {
              const standby = this.standbyNativeEl;
              if (standby) {
                this.preloadedTrackId = nextTrack.id;
                standby.src = this.streamSrc(nextTrack.id);
                standby.preload = 'auto';
                // load() without play() — just buffer the initial bytes
                standby.load();
              }
            }
          }
        }
      }
    };

    const onDuration = () => {
      if (boundGen !== this.loadGeneration) return;
      const value = audio.duration;
      if (!Number.isFinite(value) || value <= 0) return;
      // Duration gate: refuse to adopt a browser-reported duration that's far
      // off the API-known one. Keeping the API value prevents the seek bar
      // from showing 100% on a partial-parse / corrupt-cache response, and
      // keeps the false-ended recovery path in a position to detect the
      // mismatched state (browser.currentTime reaches the bad short duration
      // → ended fires → we recover rather than advance the queue).
      const known = untracked(() => this.player.currentTrack()?.duration ?? 0);
      if (!browserDurationIsAcceptable(known, value)) {
        return;
      }
      this.player.setDuration(value);
      if (this.player.recoveryState() === 'awaiting-duration') {
        // A sane duration finally arrived — exit recovery and resume from
        // where the audio element is currently parked (1-2 s into the bogus
        // short read; the browser keeps playing from there once play() is
        // called again).
        this.player.recoveryState.set('normal');
        // Cancel the valve, don't just forget it: a bare `= null` leaves the
        // 5 s timer armed and it seeks to 0 mid-playback after a good recovery.
        this.clearRecoveryTimeout();
        this.player.setBuffering(false);
        if (this.player.isPlaying()) {
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.handlePlayRejection();
          });
        }
      }
      if (this.player.restoredTime !== null) {
        audio.currentTime = this.player.restoredTime;
        this.player.restoredTime = null;
      }
      // A real duration usually means the seekable region just became known.
      this.applyPendingSeek(audio);
    };

    const onEnded = () => {
      if (boundGen !== this.loadGeneration) return;
      // False-ended guard: the browser fired `ended` but the audio timeline
      // nowhere near the API-known duration. Most commonly a VBR/lossy
      // container that reported a partial duration over the Range response,
      // or a corrupt server cache file (the bug this branch was written for).
      // Do NOT advance the queue — pause, flag recovery, wait for a real
      // duration.
      // Bounded by MAX_RECOVERY_ATTEMPTS: once a track has burned its
      // allowance the resource is genuinely short, so fall through to the
      // normal advance path instead of recovering forever.
      if (this.isFalseEnded(audio) && this.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        // A seek was still waiting on data: this `ended` is the browser having
        // clamped that target to the end of what it holds, not the track
        // finishing. Hand the target to the recovery reload so the listener
        // lands where they asked instead of back at 0. (The seekable gate in
        // applyPendingSeek should keep us out of here — this is the net for a
        // resource whose `seekable` over-promised.)
        const seekTarget = this.pendingSeekTarget();
        if (seekTarget !== null) {
          this.clearPendingSeek();
          this.player.restoredTime = seekTarget;
        }
        // Sourced from a preserved blob? Then the *stored copy* is truncated
        // and waiting/retrying can never help — swap to the network stream
        // and drop the poisoned entry instead of blind recovery.
        if (this.recoverFromTruncatedBlob(audio)) return;
        this.startRecovery(audio, boundGen);
        return;
      }
      // The track genuinely ended — a seek that never became reachable dies
      // with it rather than leaking onto whatever plays next.
      this.clearPendingSeek();
      const repeat = this.player.repeat();
      const token = this.auth.token();

      if (repeat === 'one') {
        // Repeat-one restarts the element without changing `currentTrack`, so
        // Effect 1 never re-fires — close and reopen the session here or a
        // looped track logs as one enormous play instead of N of them.
        const looped = this.player.currentTrack();
        this.tracker.end('ended');
        if (looped) this.tracker.start(looped, this.listeningSource());
        audio.currentTime = 0;
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
      } else {
        const nextTrack = this.player.queue()[0];
        if (nextTrack) {
          this.lastManualSrc = nextTrack.id;
          const standby = this.standbyNativeEl;
          const isPreloaded = standby !== null && this.preloadedTrackId === nextTrack.id;

          if (isPreloaded && standby) {
            // Standby element has the next track already buffered — swap instantly.
            // Clean up the element that just finished.
            const pendingUrl = this.lastManualObjectUrl;
            this.lastManualObjectUrl = null;
            audio.pause();
            audio.src = '';
            if (pendingUrl) URL.revokeObjectURL(pendingUrl);

            // Flip which element Effects reference.
            this.primaryIsA.update((v) => !v);
            this.preloadedTrackId = null;
            // New load on a new element — bump the generation so any stale
            // event still queued on the now-cleared old element can't make
            // it through (the new listeners capture the bumped value). Hand
            // -rolled rather than via `assignSource` because the standby's src
            // is already set (that is the point of the preload) and the
            // re-bind has to target the standby, not the element we are in.
            this.loadGeneration += 1;
            // Gapless swap — the preloaded element is different audio too.
            this.recoveryAttempts = 0;

            // Re-bind all audio listeners to the now-active element.
            this.bindAudioListeners(standby);

            // Usually clears within ms (the standby is buffered) — the 250ms visibility
            // delay means no spinner unless the swap actually stalls.
            this.player.setBuffering(true);
            this.player.setBufferedRanges([]);

            // Start playback — the element is already buffered so this is near-instant.
            standby.play().catch((err) => {
              if (document.visibilityState === 'hidden') {
                this.resumePendingAfterVisible = true;
              } else if (err.name === 'NotAllowedError') {
                this.handlePlayRejection();
              }
            });
          } else {
            // No preload available (preserved track, first track, or preload missed) — existing path.
            const isPreserved = untracked(() => this.preserve.isPreserved(nextTrack.id));

            const playNext = () => {
              this.player.setBuffering(true);
              this.player.setBufferedRanges([]);
              audio.play().catch((err) => {
                if (document.visibilityState === 'hidden') {
                  this.resumePendingAfterVisible = true;
                } else if (err.name === 'NotAllowedError') {
                  this.handlePlayRejection();
                }
              });
            };

            if (isPreserved) {
              void db.getBlob(nextTrack.id).then((blob) => {
                if (blob) {
                  const url = URL.createObjectURL(blob.audio);
                  this.lastManualObjectUrl = url;
                  this.assignSource(audio, url);
                  playNext();
                } else if (untracked(() => !this.network.online())) {
                  // Metadata preserved but blob missing, and offline — don't
                  // stall on an unreachable stream.
                  this.stopForOffline(audio, nextTrack.title);
                } else {
                  this.assignSource(audio, this.streamSrc(nextTrack.id, token));
                  playNext();
                }
              });
            } else if (untracked(() => !this.network.online())) {
              // Offline and the next track isn't downloaded — stop instead of
              // pointing <audio> at a stream that will only spin forever.
              this.stopForOffline(audio, nextTrack.title);
            } else {
              this.assignSource(audio, this.streamSrc(nextTrack.id, token));
              playNext();
            }
          }
        }
        // The track reached its natural end — the one unambiguous completion.
        this.tracker.end('ended');
        this.player.playNext();
      }
    };

    const onPlay = () => {
      if (boundGen !== this.loadGeneration) return;
      // Cancel any deferred pause — audio resumed before the timer fired.
      if (this.backgroundPauseTimer !== null) {
        clearTimeout(this.backgroundPauseTimer);
        this.backgroundPauseTimer = null;
      }
      if (!this.player.isPlaying()) {
        this.player.resume();
      }
    };
    const onPause = () => {
      if (boundGen !== this.loadGeneration) return;
      if (this.pausingByStore || this.recoveringStream) return;
      if (document.visibilityState === 'hidden') {
        this.resumePendingAfterVisible = this.player.isPlaying();
        return;
      }
      // Android race: audio.pause can fire before visibilitychange(hidden) when the
      // OS yanks audio focus. Defer committing the pause so visibilitychange arrives first.
      this.backgroundPauseTimer = setTimeout(() => {
        this.backgroundPauseTimer = null;
        if (this.recoveringStream) return;
        if (document.visibilityState === 'hidden') {
          this.resumePendingAfterVisible = this.player.isPlaying();
        } else if (this.player.isPlaying()) {
          this.player.pause();
        }
      }, 250);
    };

    const onWaiting = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(true);
      this.armStallWatchdog(audio, boundGen);
    };
    const onSeeking = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(true);
    };
    // Seeking into an already-buffered region fires no playing/canplay while
    // paused (readyState never dips), so seeked must clear the flag itself —
    // but only when data is really there; unbuffered targets keep the spinner
    // up until waiting/canplay resolve it.
    const onSeeked = () => {
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) this.player.setBuffering(false);
    };
    // stalled also fires on harmless network hiccups while plenty is buffered —
    // only treat it as buffering when playback genuinely can't proceed.
    const onStalled = () => {
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        this.player.setBuffering(true);
        this.armStallWatchdog(audio, boundGen);
      }
    };
    const onPlaying = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(false);
      this.clearStallTimeout();
    };
    const onCanPlay = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(false);
      this.clearStallTimeout();
      this.applyPendingSeek(audio);
      // `canplay` is a coarser signal than `durationchange` but it's the
      // earliest event that proves the browser has enough bytes to play —
      // exit recovery if the current duration is sane.
      const d = audio.duration;
      const known = untracked(() => this.player.currentTrack()?.duration ?? 0);
      if (
        this.player.recoveryState() === 'awaiting-duration' &&
        Number.isFinite(d) &&
        d > 0 &&
        browserDurationIsAcceptable(known, d)
      ) {
        this.player.recoveryState.set('normal');
        this.clearRecoveryTimeout();
        this.player.setBuffering(false);
        if (this.player.isPlaying()) {
          audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') this.handlePlayRejection();
          });
        }
      }
    };
    const onError = () => {
      if (boundGen !== this.loadGeneration) return;
      this.player.setBuffering(false);
      // Not the end of the story: the transfer died, and the resource is
      // almost always still there. Reload it and resume (bounded) rather than
      // leaving a player that claims to be playing silence.
      this.recoverFromDeadStream(audio, boundGen);
    };
    const onProgress = () => {
      if (boundGen !== this.loadGeneration) return;
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < audio.buffered.length; i++) {
        ranges.push({ start: audio.buffered.start(i), end: audio.buffered.end(i) });
      }
      this.player.setBufferedRanges(ranges);
      // Data arriving is the signal a held seek has been waiting for.
      this.applyPendingSeek(audio);
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('seeking', onSeeking);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('stalled', onStalled);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);
    audio.addEventListener('progress', onProgress);

    this.audioListenerCleanups = [
      () => audio.removeEventListener('timeupdate', onTime),
      () => audio.removeEventListener('loadedmetadata', onDuration),
      () => audio.removeEventListener('durationchange', onDuration),
      () => audio.removeEventListener('ended', onEnded),
      () => audio.removeEventListener('play', onPlay),
      () => audio.removeEventListener('pause', onPause),
      () => audio.removeEventListener('waiting', onWaiting),
      () => audio.removeEventListener('seeking', onSeeking),
      () => audio.removeEventListener('seeked', onSeeked),
      () => audio.removeEventListener('stalled', onStalled),
      () => audio.removeEventListener('playing', onPlaying),
      () => audio.removeEventListener('canplay', onCanPlay),
      () => audio.removeEventListener('error', onError),
      () => audio.removeEventListener('progress', onProgress),
    ];
  }

  /**
   * Heuristic for a false `ended` event: the browser believes playback reached
   * the end of the resource, but the timeline is suspiciously short relative
   * to the API-known track duration. Either the browser mis-parsed a VBR /
   * lossy container over a Range response, or the server handed us a
   * corrupt/transcoded-too-short file.
   */
  private isFalseEnded(audio: HTMLAudioElement): boolean {
    const t = audio.currentTime;
    const d = audio.duration;
    if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return false;
    const known = untracked(() => this.player.currentTrack()?.duration ?? 0);
    if (known > 0) {
      if (t < known * 0.7) return true;
      if (Math.abs(d - known) > 5 && d < known * 0.9) return true;
      return false;
    }
    // No API-known duration to compare against (issue #234 — a scan that
    // couldn't read tag duration, or an untagged acquisition). Fall back to
    // the absolute floor rather than skipping the check entirely.
    return t < FALSE_ENDED_ABSOLUTE_FLOOR_SEC && d < FALSE_ENDED_ABSOLUTE_FLOOR_SEC;
  }

  /**
   * A false `ended` while playing from a preserved (IndexedDB) blob means the
   * stored copy itself is truncated — a partial fetch that slipped into the
   * store. Recovery-by-retry is pointless there: the blob replays the same
   * few seconds on this and every future play (the store is durable), so the
   * track stays broken long after the network recovered. Drop the poisoned
   * entry and re-point the element at the network stream, keeping the user's
   * play intent. Returns false (caller falls back to the bounded blind
   * recovery) when there's no track, the source isn't a blob, or we're
   * offline — where the bad blob is still the only source there is.
   */
  private recoverFromTruncatedBlob(audio: HTMLAudioElement): boolean {
    const track = untracked(() => this.player.currentTrack());
    if (!track) return false;
    const src = audio.currentSrc || audio.src;
    if (!src.startsWith('blob:')) return false;
    if (!untracked(() => this.preserve.isPreserved(track.id))) return false;
    if (untracked(() => !this.network.online())) return false;

    // Counts against the same allowance as blind recovery, so a truncated
    // network stream after the swap still has a bounded retry budget.
    this.recoveryAttempts += 1;
    void this.preserve.remove(track.id);
    this.player.setBuffering(true);
    this.player.setBufferedRanges([]);
    const badUrl = this.lastManualObjectUrl;
    this.lastManualObjectUrl = null;
    this.assignSource(audio, this.streamSrc(track.id));
    if (badUrl) URL.revokeObjectURL(badUrl);
    this.playIfIntended(audio);
    return true;
  }

  // ─── Dead-stream recovery ────────────────────────────────────────────────
  // The false-ended flow above handles a stream that ends *too early*. This one
  // handles a stream that stops delivering altogether: the element raises
  // `error`, or simply parks on `waiting` and never asks for another byte. Both
  // used to be terminal — `onError` only cleared the spinner — so a transfer
  // the network dropped left the player silently dead while the store still
  // said "playing" and the seek bar sat frozen. Nothing retried, and only a
  // manual press brought the music back.

  /** Backoff timer for the pending stream reload. */
  private mediaRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Watchdog for a stream that stopped progressing without raising `error`. */
  private stallTimeout: ReturnType<typeof setTimeout> | null = null;
  /** `currentTime` when the watchdog was armed — progress past it means alive. */
  private stallWatchFrom = 0;
  /**
   * The load generation `teardownAudio` parked. Assigning `src = ''` raises
   * `error` on the element, and that error must never be read as a stream to
   * recover — recovering a parked element would re-point it at audio the app
   * just decided to stop (and, offline, would re-enter `stopForOffline`
   * forever).
   */
  private parkedGeneration = -1;
  /** A dead stream waiting for the network to come back (see Effect 9). */
  private retryOnReconnect = false;
  /**
   * True while a dead-stream reload owns the element's paused state.
   *
   * A fatal media error pauses the element itself, and `onPause` would commit
   * that to the store ~250 ms later — before the reload runs, and against an
   * intent the listener never withdrew. The recovery then found `isPlaying`
   * already false and stood down, which is precisely the "it just stops" this
   * whole path exists to remove.
   */
  private recoveringStream = false;

  /**
   * Take ownership of the element's paused state for the length of a recovery:
   * the `pause` the failure itself raises must not reach the store, and a
   * deferred one already in flight must not land either.
   */
  private holdPausedState(): void {
    this.recoveringStream = true;
    if (this.backgroundPauseTimer !== null) {
      clearTimeout(this.backgroundPauseTimer);
      this.backgroundPauseTimer = null;
    }
  }

  private clearMediaRetryTimeout(): void {
    if (this.mediaRetryTimeout !== null) {
      clearTimeout(this.mediaRetryTimeout);
      this.mediaRetryTimeout = null;
    }
  }

  private clearStallTimeout(): void {
    if (this.stallTimeout !== null) {
      clearTimeout(this.stallTimeout);
      this.stallTimeout = null;
    }
  }

  /**
   * Watch a stream that has stopped delivering. Armed by `waiting`/`stalled`,
   * disarmed the moment a byte lands (`playing`/`canplay`/`timeupdate`), so it
   * only ever fires for a load that made no progress for the whole window.
   */
  private armStallWatchdog(audio: HTMLAudioElement, boundGen: number): void {
    if (this.stallTimeout !== null) return;
    if (!untracked(() => this.player.isPlaying())) return;
    this.stallWatchFrom = audio.currentTime;
    this.stallTimeout = setTimeout(() => {
      this.stallTimeout = null;
      if (boundGen !== this.loadGeneration) return;
      // A seek in flight, or the false-ended valve mid-flight, owns the
      // element's silence and has its own bounded resolution. Don't race them.
      if (audio.seeking) return;
      if (untracked(() => this.player.recoveryState()) === 'awaiting-duration') return;
      if (audio.currentTime > this.stallWatchFrom + 0.5) return;
      this.recoverFromDeadStream(audio, boundGen);
    }, STREAM_STALL_TIMEOUT_MS);
  }

  /**
   * Re-point the element at the same track and resume where the listener was.
   *
   * Bounded by the same `MAX_RECOVERY_ATTEMPTS` allowance as the false-ended
   * flow (one budget per resource, reset when a new one loads), so a track
   * whose bytes are genuinely unreachable cannot retry forever. When the budget
   * is spent the player pauses for real: a paused player the user can restart
   * is honest, a "playing" one with no sound is not.
   */
  private recoverFromDeadStream(audio: HTMLAudioElement, boundGen: number): void {
    if (boundGen !== this.loadGeneration) return;
    if (this.loadGeneration === this.parkedGeneration) return;
    if (this.mediaRetryTimeout !== null) return; // a reload is already pending
    if (!untracked(() => this.player.isPlaying())) return; // paused: nothing to save
    if (!this.isActiveDevice()) return; // a remote device owns playback
    const track = untracked(() => this.player.currentTrack());
    if (!track) return;

    // A truncated preserved blob has a better cure than a reload of itself:
    // drop the poisoned entry and swap to the network stream.
    if (this.recoverFromTruncatedBlob(audio)) return;
    if (untracked(() => !this.network.online())) {
      // The bytes are not coming back until the network does. Retrying now
      // would burn the budget against a dead radio, and tearing the track down
      // would punish exactly the case this recovery exists for — a phone that
      // loses signal for a few seconds. Hold the intent and let the reconnect
      // effect resume it.
      this.retryOnReconnect = true;
      this.holdPausedState();
      this.player.setBuffering(true);
      return;
    }
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.clearStallTimeout();
      this.recoveringStream = false;
      this.player.setBuffering(false);
      this.player.pause();
      this.toast.show({
        message: this.i18n.t('player.streamInterrupted', { title: track.title }),
        kind: 'error',
      });
      return;
    }

    this.recoveryAttempts += 1;
    const resumeAt = audio.currentTime;
    this.clearStallTimeout();
    this.holdPausedState();
    this.player.setBuffering(true);
    this.mediaRetryTimeout = setTimeout(() => {
      this.mediaRetryTimeout = null;
      this.recoveringStream = false;
      if (boundGen !== this.loadGeneration) return;
      if (!untracked(() => this.player.isPlaying())) {
        this.player.setBuffering(false);
        return;
      }
      // Same restore mechanism as the vocal-mute reload: `onDuration` replays
      // `restoredTime` once the new load reports a sane duration, so the
      // listener lands where the stream died instead of back at 0.
      if (Number.isFinite(resumeAt) && resumeAt > 1) this.player.restoredTime = resumeAt;
      this.assignSource(audio, this.streamSrc(track.id));
      this.playIfIntended(audio);
    }, MEDIA_ERROR_RETRY_MS);
  }

  /** The timer handle for the false-ended recovery fallback (5 s). */
  private recoveryTimeout: ReturnType<typeof setTimeout> | null = null;

  // False-ended recoveries spent on the current resource, bounded by
  // MAX_RECOVERY_ATTEMPTS. Reset whenever a new resource takes over.
  private recoveryAttempts = 0;

  /** Cancels the recovery valve. The one place the handle is torn down. */
  private clearRecoveryTimeout(): void {
    if (this.recoveryTimeout !== null) {
      clearTimeout(this.recoveryTimeout);
      this.recoveryTimeout = null;
    }
  }

  /**
   * Begin the false-ended recovery flow: pause the audio element, surface
   * the buffering indicator, and wait for a real `durationchange` (or
   * `canplay` with a sane duration) so we can resume from the correct
   * position. If nothing arrives within 5 s, the response the browser holds
   * is probably genuinely short/truncated — give up waiting, reload the
   * source and play so the user isn't stuck.
   */
  private startRecovery(audio: HTMLAudioElement, boundGen: number): void {
    if (this.player.recoveryState() === 'awaiting-duration') return; // already recovering
    this.recoveryAttempts += 1;
    this.player.recoveryState.set('awaiting-duration');
    this.player.setBuffering(true);
    this.clearRecoveryTimeout();
    // Where the listener should come back to once the reload produces a real
    // timeline: the target of a seek that provoked this `ended` (onEnded parks
    // it in restoredTime), otherwise however far playback had actually got.
    // Captured now because `load()` below resets the element's own clock.
    const resumeAt = this.player.restoredTime ?? audio.currentTime;
    this.recoveryTimeout = setTimeout(() => {
      if (boundGen !== this.loadGeneration) return;
      this.recoveryTimeout = null;
      this.player.recoveryState.set('normal');
      this.player.setBuffering(false);
      // Resume where the listener was, not at 0. onDuration replays
      // `restoredTime` once a sane duration lands; without this the valve
      // threw away everything before the fault on every fire — the visible
      // half of "I seek forward and the track starts over".
      if (Number.isFinite(resumeAt) && resumeAt > 1) this.player.restoredTime = resumeAt;
      // load(), not `currentTime = 0`: after a stream cut short mid-transfer
      // the browser's media cache still holds the truncated resource, so a
      // bare seek-to-0 + play replays the same few seconds and feeds the next
      // false `ended` without a single new byte ever being requested. load()
      // drops the cached data, refetches the src from the start, and gives an
      // interrupted stream a real second chance (position resets to 0 either
      // way). A blob: src just re-reads the same blob — no worse than before.
      audio.load();
      if (this.player.isPlaying()) {
        audio.play().catch((err) => {
          if (err.name === 'NotAllowedError') this.handlePlayRejection();
        });
      }
    }, 5000);
  }

  ngOnDestroy(): void {
    this.audioListenerCleanups.forEach((fn) => fn());
    if (this.backgroundPauseTimer !== null) clearTimeout(this.backgroundPauseTimer);
    this.clearRecoveryTimeout();
    this.clearMediaRetryTimeout();
    this.clearStallTimeout();
    this.clearPendingSeekTimeout();
    if (this.progressReportInterval) clearInterval(this.progressReportInterval);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.releaseWakeLock();
    if (this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
    }
  }

  /** Quick-interaction like/unlike on the mini-player bar (bug: the like
   *  button was only reachable via the ⋯ menu / track row / track-info sheet
   *  — see docs/song-actions.md). */
  toggleLike(): void {
    const id = this.player.currentTrack()?.id;
    if (id) void this.likes.toggle(id);
  }

  handlePlayPause(): void {
    if (this.isActiveDevice()) {
      if (this.player.isPlaying()) this.player.pause();
      else this.player.resume();
    } else {
      this.ws.sendCommand(this.remote.remoteIsPlaying() ? 'PAUSE' : 'PLAY');
    }
  }

  /**
   * How the current track was reached, recorded alongside the play so history
   * can later answer "did radio or my own albums drive my listening". Radio
   * wins over the context, since a filter-radio vibe keeps the seed's context.
   */
  private listeningSource(): string | null {
    if (this.player.radio() || this.player.radioFilter()) return 'radio';
    return this.player.context()?.type ?? null;
  }

  handleNext(): void {
    if (this.isActiveDevice()) {
      // A deliberate skip — closed here rather than in onEnded, which is the
      // only other way the track can end and means the opposite thing.
      this.tracker.end('skipped');
      this.player.playNext();
    } else this.ws.sendCommand('NEXT');
  }

  handlePrev(): void {
    const audio = this.audioEl()?.nativeElement;
    if (this.isActiveDevice()) {
      if (audio && audio.currentTime > 3) {
        // Restarting the same track, not leaving it — the session continues
        // (the backward jump is a seek, which `accumulate` already ignores).
        audio.currentTime = 0;
      } else {
        this.tracker.end('skipped');
        this.player.playPrev();
      }
    } else {
      this.ws.sendCommand('PREV');
    }
  }

  // Seek commit from app-seek-bar (native range — see SeekBarComponent for why
  // a range input replaced the old div + pointer-math that kept regressing on
  // Firefox). Fires once on release: scrub locally for the active device, or
  // forward a SEEK command to the remote device.
  onSeek(time: number): void {
    if (this.isActiveDevice()) {
      // Through the store, not straight at the element: Effect 6 is the single
      // applier, so the seek bar and the OS media controls share one
      // pending-intent record and one availability gate.
      this.player.seek(time);
    } else {
      this.ws.sendCommand('SEEK', { position: time });
      this.remote.setRemoteProgress(time, this.safeDuration());
    }
  }

  // Open is tap/swipe-up driven, not live-follow: the 64px mini bar is too short
  // to meaningfully follow a finger, and the Now Playing sheet lives in a separate
  // component. Live-follow is reserved for the dismiss drag (now-playing.component).
  private static readonly OPEN_THRESHOLD_PX = 40;
  private static readonly TAP_TOLERANCE_PX = 10;

  // The bar itself does not move during the gesture; we only track start→end
  // displacement to distinguish a tap / swipe-up (open Now Playing) from a scroll.
  private readonly barDrag = createPointerDrag({
    onMove: (event, start) => {
      // Commit the open the moment an upward swipe crosses the threshold rather
      // than waiting for pointerup: on touch the browser can reclaim a vertical
      // pan and fire pointercancel before pointerup, so the old end-only check
      // dropped real swipes. Idempotent — set(true) is a no-op once open.
      if (start.clientY - event.clientY > PlayerComponent.OPEN_THRESHOLD_PX) {
        this.player.setNowPlayingOpen(true);
      }
    },
    onEnd: (event, start) => {
      const deltaY = event.clientY - start.clientY;
      if (Math.abs(deltaY) <= PlayerComponent.TAP_TOLERANCE_PX) {
        this.player.setNowPlayingOpen(true);
      }
    },
  });

  /** The keyboard/D-pad route into the expand gesture (issue #432). The notch
   *  stays a `<div>` rather than a `<button>` on purpose: `onBarPointerDown`
   *  bails on `closest('button')`, so promoting it would kill the touch
   *  swipe-to-open drag it exists to serve. Idempotent, so the click a tap
   *  fires alongside the pointer gesture is harmless. */
  openNowPlaying(): void {
    this.player.setNowPlayingOpen(true);
  }

  onBarPointerDown(event: PointerEvent): void {
    // Don't hijack control buttons or the desktop seek bar.
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-seek]')) return;
    this.barDrag.start(event);
  }

  formatTime(s: number): string {
    return formatTime(s);
  }
}
