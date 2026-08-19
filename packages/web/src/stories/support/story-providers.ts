/**
 * Providers every story of a service-injecting component needs.
 *
 * There are no fake service classes here, and that is deliberate. Every service the
 * light-DI components inject is a plain signal holder whose only outside dependency is
 * HttpClient — so stories run the *real* services and fake the transport
 * (`fixtureHttpInterceptor`) plus the starting signal state. A fake class would be a
 * second implementation to keep in sync, and it can stay green while the real one breaks.
 */
import {
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
import { DownloadReviewService } from '../../app/services/download-review.service';
import type { AcquireJob } from '../../app/services/acquire.service';
import type { AcquisitionJobView } from '../../types/core';
import {
  FeedbackSheetService,
  type FeedbackSheetPayload,
} from '../../app/services/feedback-sheet.service';
import { getStoryLang } from './story-lang';
import { PlayerService } from '../../app/services/player.service';
import type { Track } from '../../app/services/player.service';

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
  pendingReviews?: number;
  /**
   * Opens the hunt-feedback detail sheet. The sheet renders nothing until
   * `FeedbackSheetService.payload()` is non-null — it is a globally-hosted
   * overlay opened from a toast action — so a story without this seeds an
   * empty canvas rather than the sheet.
   */
  feedbackSheet?: FeedbackSheetPayload;
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
    lidarrAlbumId: null,
    sourceRef: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    albumId: null,
    progress: { expected: 12, delivered: 5, unavailable: 0, failed: 0 },
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
      if (state.pendingReviews !== undefined) {
        inject(DownloadReviewService).pending.set(state.pendingReviews);
      }
      if (state.feedbackSheet !== undefined) {
        inject(FeedbackSheetService).payload.set(state.feedbackSheet);
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
