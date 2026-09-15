/**
 * Providers every story of a service-injecting component needs.
 *
 * There are no fake service classes here, and that is deliberate. Every service the
 * light-DI components inject is a plain signal holder whose only outside dependency is
 * HttpClient — so stories run the *real* services and fake the transport
 * (`fixtureHttpInterceptor`) plus the starting signal state. A fake class would be a
 * second implementation to keep in sync, and it can stay green while the real one breaks.
 *
 * The two subclasses below are the app-shell exception, and they keep that rule rather
 * than break it: each overrides exactly **one method**, both of them a transport
 * `HttpClient` never carries — the `<audio>` element's own resource load, and the
 * `EventSource`. Every other line of both services is the real one, so neither can
 * drift from an implementation it stands in for.
 */
import {
  Injectable,
  provideAppInitializer,
  inject,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { APP_VERSION } from '../../app/app.config';
import { fixtureHttpInterceptor } from './http-fixtures';
import { AuthService } from '../../app/services/auth.service';
import { TranslateService } from '../../app/services/translate.service';
import { TransferService } from '../../app/services/transfer.service';
import { AcquireService } from '../../app/services/acquire.service';
import type { AcquireJob } from '../../app/services/acquire.service';
import type { AcquisitionJobView } from '../../types/core';
import { ArtistImageSourcesService } from '../../app/services/artist-image-sources.service';
import { getStoryLang } from './story-lang';
import { PlayerService } from '../../app/services/player.service';
import type { Track } from '../../app/services/player.service';
import { RemotePlaybackService } from '../../app/services/remote-playback.service';
import type { RemoteDevice } from '../../app/services/remote-playback.service';
import { NetworkStatusService } from '../../app/services/network-status.service';
import { LibraryEventsService } from '../../app/services/library-events.service';
import { ServerConfigService } from '../../app/services/server-config.service';
import { silentStreamUrl, stalledStreamUrl } from './story-audio';

export interface StoryState {
  /** Role the component should render for. `listener` hides acquisition affordances. */
  role?: 'listener' | 'user' | 'refiner' | 'admin';
  /** Track the player reports as current — drives the track-row playing indicator. */
  currentTrack?: Track | null;
  isPlaying?: boolean;
  /** Drives the buffering spinner / track-row buffering indicator. */
  buffering?: boolean;
  queue?: Track[];
  /**
   * Counts behind the download badge. Seeded as the *upstream* signals rather
   * than the derived count, because `activeDownloadCount`/`activeJobs` are
   * `computed()` — writing the derived value is impossible, and faking it would
   * bypass the very filter (kind/state) the badge depends on.
   *
   * Neither service polls until `startPolling()` is called, so a story that
   * injects them stays inert; no timer to stop, no request to intercept.
   */
  downloadingTransfers?: number;
  activeAcquireJobs?: number;
  /**
   * Which providers can resolve an artist portrait (issue #422). `null` is the
   * pre-load optimistic state, `[]` means no source is configured — which is
   * what disables "Fetch automatically" rather than offering a control that
   * cannot do anything.
   */
  artistImageSources?: string[] | null;
  /** A remote-playback session as the server would have synced it: who the
   *  output is and the device list. Storybook has no WebSocket, so this is the
   *  only way a controller-side story sees a session. */
  remoteSession?: { activeDeviceId: string | null; devices: RemoteDevice[] };
  /**
   * Where playback is parked. Applied through the player's own session-restore
   * field, so the position lands on the audio element the same way a reload
   * lands it — a story that leaves it at 0 shows an empty seek bar and no
   * elapsed time.
   */
  restoredTime?: number;
  /** Opens the Now Playing sheet. It is never unmounted, only translated below
   *  the viewport, so a story that does not open it renders off-canvas. */
  nowPlayingOpen?: boolean;
  /**
   * The device reports no network. `NetworkStatusService` is what
   * `SetupService.isOffline()` folds in, so this is what raises the shell's
   * offline banner and the player's offline handling — no HTTP failure needed.
   */
  offline?: boolean;
  /**
   * What the `<audio>` element is handed for bytes (see `story-audio.ts`).
   * `stalled` is a stream that never delivers one, which is the only way a
   * buffering story keeps its spinner.
   */
  audioTransport?: 'silent' | 'stalled';
  /**
   * Open a real `GET /api/library/events` SSE stream on mount. Off by default:
   * `EventSource` is not `HttpClient`, so the fixture interceptor cannot answer
   * it and the request leaves the page for the Storybook server, which 404s it.
   * Measured, not assumed: that 404 is *fatal* to an `EventSource` (a non-2xx
   * response fails the connection for good), so one request and one console
   * error is the whole cost — it does not retry. Turn it on only when Storybook
   * is pointed at a real dev server.
   */
  liveEvents?: boolean;
}

/**
 * The `<audio>` element's resource is not `HttpClient` traffic, so
 * `fixtureHttpInterceptor` never sees it. Overriding this one method is what
 * keeps a story off the network — everything else about the service (base URL
 * resolution, `apiUrl`, `sseUrl`, the saved-server registry) stays real.
 */
class StoryServerConfigService extends ServerConfigService {
  constructor(private readonly transport: 'silent' | 'stalled') {
    super();
  }

  override streamUrl(): string {
    return this.transport === 'stalled' ? stalledStreamUrl() : silentStreamUrl();
  }
}

/**
 * `start()` is the only thing that opens the `EventSource`; the rest of the
 * service (the event fan-out `apply()` and its signals) is left alone.
 *
 * `@Injectable()` is not decoration: Angular warns — and will eventually
 * throw — when DI instantiates a class that only inherits its decorator.
 */
@Injectable()
class InertLibraryEventsService extends LibraryEventsService {
  override start(): void {}
}

/**
 * Fully-typed fixtures rather than a cast.
 *
 * A `Partial<...> as X` would compile today and silently stop matching the real
 * shape the moment a required field is added or a union member renamed — which
 * is the same drift the "no fake service classes" rule at the top of this file
 * exists to avoid. Building the real object means the type checker keeps these
 * honest.
 */
function downloadingJob(id: string): AcquisitionJobView {
  return {
    id,
    kind: 'album-hunt',
    method: 'slskd',
    state: 'active',
    stage: 'downloading',
    artistName: 'Bola de Nieve',
    albumTitle: 'Bola de Nieve',
    displayTitle: null,
    sourceUrl: null,
    playlistId: null,
    lidarrAlbumId: null,
    sourceRef: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    albumId: null,
    progress: { expected: 12, delivered: 5, unavailable: 0, failed: 0, canonical: null },
    items: [],
    sources: [],
    destinationAlbums: [],
  };
}

function runningAcquireJob(id: string): AcquireJob {
  return {
    id,
    backend: 'ytdlp',
    url: 'https://example.invalid/track',
    label: 'A track',
    state: 'running',
    progress: { done: 1, total: 3 },
    error: null,
    created_at: 0,
  };
}

export function storyProviders(state: StoryState = {}): Array<Provider | EnvironmentProviders> {
  return [
    provideHttpClient(withInterceptors([fixtureHttpInterceptor])),
    // Initial navigation is disabled because the story URL is `/iframe.html`, which
    // matches no route — an empty route table made every RouterLink-bearing component
    // throw NG04002 on mount. Links still resolve; nothing navigates.
    provideRouter([], withDisabledInitialNavigation()),
    // UpdateService injects SwUpdate + APP_VERSION. Registration is disabled, so this
    // supplies an inert SwUpdate rather than a fake service.
    provideServiceWorker('ngsw-worker.js', { enabled: false }),
    { provide: APP_VERSION, useValue: '0.0.0-storybook' },
    {
      provide: ServerConfigService,
      useFactory: () => new StoryServerConfigService(state.audioTransport ?? 'silent'),
    },
    ...(state.liveEvents
      ? []
      : [{ provide: LibraryEventsService, useClass: InertLibraryEventsService }]),
    provideAppInitializer(() => {
      const auth = inject(AuthService);
      const player = inject(PlayerService);
      const translate = inject(TranslateService);

      // A signed-in admin is the default because it is the only role that renders every
      // affordance; role-gated stories narrow it explicitly.
      auth.token.set('storybook-token');
      auth.username.set('storybook');
      auth.role.set(state.role ?? 'admin');

      if (state.currentTrack !== undefined) player.currentTrack.set(state.currentTrack);
      if (state.isPlaying !== undefined) player.isPlaying.set(state.isPlaying);
      if (state.buffering !== undefined) {
        player.buffering.set(state.buffering);
        player.bufferingVisible.set(state.buffering);
      }
      if (state.queue !== undefined) player.queue.set(state.queue);
      if (state.restoredTime !== undefined) player.restoredTime = state.restoredTime;
      if (state.nowPlayingOpen !== undefined) player.nowPlayingOpen.set(state.nowPlayingOpen);
      if (state.offline) inject(NetworkStatusService).online.set(false);

      if (state.downloadingTransfers !== undefined) {
        inject(TransferService).acquisitionJobs.set(
          Array.from({ length: state.downloadingTransfers }, (_, i) => downloadingJob(`job-${i}`)),
        );
      }
      if (state.activeAcquireJobs !== undefined) {
        inject(AcquireService).jobs.set(
          Array.from({ length: state.activeAcquireJobs }, (_, i) => runningAcquireJob(`acq-${i}`)),
        );
      }
      if (state.artistImageSources !== undefined) {
        inject(ArtistImageSourcesService).sources.set(state.artistImageSources);
      }
      if (state.remoteSession !== undefined) {
        const remote = inject(RemotePlaybackService);
        remote.setDevices(state.remoteSession.devices);
        remote.setActiveDeviceId(state.remoteSession.activeDeviceId);
      }
      // Load the REAL catalogs, not a stub: Storybook serves `public/` via
      // `staticDirs`, so `/i18n/en.json` and `/i18n/es.json` are the same files
      // the app ships. A stub with invented strings would stop the story
      // testing the actual copy, which is the whole point of the lang global.
      // Returned so Angular waits for it — otherwise the first paint renders
      // raw keys and a screenshot catches the wrong frame.
      return translate.init().then(() => translate.use(getStoryLang()));
    }),
  ];
}
