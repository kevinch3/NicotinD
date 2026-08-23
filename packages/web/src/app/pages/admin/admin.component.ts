import { Component, computed, inject, signal, effect, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { ProcessingSettings, ProcessingStatus, ProcessingTaskId } from '../../../types/core';
import { ROLES, type Role } from '../../../types/core';
import { SystemApiService } from '../../services/api/system-api.service';
import { chunk } from '../../lib/tv-nav-grid';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ServiceReviewService } from '../../services/service-review.service';
import { AcquisitionSettingsService } from '../../services/acquisition-settings.service';
import type {
  AdminUser,
  BackupInfo,
  IncompleteAlbumJob,
  QuarantineAlbum,
  SongSteps,
  LibraryFragmentReport,
  LibraryDuplicateAlbumCluster,
  LibraryHiddenByClassification,
  LibraryFragmentFinding,
  MissplitMember,
  StreamingSettings,
  UntrackedDownload,
  AutoPlaylistStatus,
  AutoPlaylistCadence,
  ConfigBundle,
  ImportPlan,
} from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../services/confirm.service';
import { MenuPanelComponent } from '../../components/menu-panel/menu-panel.component';
import type { Translator } from '../../lib/relative-time';
import { userActivityLabel, userActivityDetail } from '../../lib/user-activity';
import {
  progressPercent,
  phaseLabel,
  totalPending,
  isRunning,
  runOutcomeToast,
} from '../../lib/processing-progress';
import {
  detailPairs,
  isMaintenanceRunning,
  isTaskRunning,
  maintenanceOutcome,
  maintenanceProgressPercent,
} from '../../lib/maintenance-progress';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';
import { MetricPillComponent } from '../../components/metric-pill/metric-pill.component';
import { DiscographyAlbum } from '../../services/api/api-types';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { SettingsGroupComponent } from '../../components/settings-group/settings-group.component';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';
import { RadioPollsCardComponent } from './radio-polls/radio-polls-card.component';
import { UserManagementPanelComponent } from './user-management/user-management-panel.component';
import { SystemHealthPanelComponent } from './system-health/system-health-panel.component';
import { BackupsDataPanelComponent } from './backups-data/backups-data-panel.component';
import { StreamingMediaPanelComponent } from './streaming-media/streaming-media-panel.component';
import { AcquisitionAutomationPanelComponent } from './acquisition-automation/acquisition-automation-panel.component';
import { AuditLogPanelComponent } from './audit-log/audit-log-panel.component';

/** A copy in a duplicate group — shape returned by the maintenance duplicates API. */
type DuplicateSong = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
  bitRate?: number;
  suffix?: string;
  path: string;
  coverArt?: string;
};

@Component({
  selector: 'app-admin',
  imports: [
    FormsModule,
    PasswordFieldComponent,
    AlbumHuntModalComponent,
    MetricPillComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
    SettingsGroupComponent,
    BottomChromeSafeDirective,
    RadioPollsCardComponent,
    UserManagementPanelComponent,
    SystemHealthPanelComponent,
    BackupsDataPanelComponent,
    StreamingMediaPanelComponent,
    AcquisitionAutomationPanelComponent,
    AuditLogPanelComponent,
    MenuPanelComponent,
  ],
  templateUrl: './admin.component.html',
})
export class AdminComponent implements OnInit, OnDestroy {
  readonly chunk = chunk;
  private api = inject(SystemApiService);
  private downloadsApi = inject(DownloadsApiService);
  private libraryApi = inject(LibraryApiService);
  private auth = inject(AuthService);
  private server = inject(ServerConfigService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  readonly i18n = inject(TranslateService);
  /** One consolidated snapshot for every read-only Admin telemetry — replaces
   *  the per-section loaders the page used to manage (systemStatus, scanStatus,
   *  updateCheck, backups, auditLog, incompleteJobs, untracked, hardware metrics).
   *  Write actions (settings forms, restart, run-now, etc.) keep their own
   *  PATCH-shape endpoints; this service is the snapshot companion. */
  protected readonly reviewSvc = inject(ServiceReviewService);
  protected readonly acqSvc = inject(AcquisitionSettingsService);

  // Library-wide metadata optimization (cover/year/release-type from Lidarr).
  // Running truth lives in the ServiceReview `maintenance` slice (issue #622);
  // this only covers the request round-trip before the first poll lands.
  readonly optimizeStarting = signal(false);
  readonly optimizeMetadataMsg = signal<string | null>(null);

  // Action-only loaders (snapshot equivalents drain from ServiceReviewService).
  readonly syncing = signal(false);
  readonly syncMsg = signal<string | null>(null);

  // Automated playlists (issue #228): cadence control + manual "generate now".

  readonly loadingFragments = signal(false);
  readonly fragments = signal<LibraryFragmentReport | null>(null);
  readonly fragmentsError = signal<string | null>(null);

  // Acquisition kill-switch (issue #235). `configurable` false = the env
  // disabled it, a floor an admin cannot lift, so the control goes read-only.

  // Windowed processing — settings form (PATCHed separately), live progress SSE.
  readonly processing = signal<ProcessingSettings | null>(null);
  readonly processingStarting = signal(false);
  readonly processingMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  private processingStream: EventSource | null = null;
  readonly quarantineQueue = signal<QuarantineAlbum[]>([]);
  readonly stepKeys = [
    'bpm',
    'key',
    'energy',
    'genre',
    'mood',
  ] as const satisfies (keyof SongSteps)[];
  private awaitingRun = false;
  private sawRunning = false;

  // Library maintenance: find duplicates (action-only).
  readonly duplicatesLoading = signal(false);
  readonly duplicates = signal<DuplicateSong[][]>([]);
  readonly duplicatesDeleteSet = signal<Set<string>>(new Set());
  readonly duplicatesMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly deletingDuplicates = signal(false);

  readonly retryAlbum = signal<DiscographyAlbum | null>(null);
  readonly retryArtist = signal('');

  // ServiceReview slices — exposed for the template.
  readonly incompleteJobs = this.reviewSvc.incompleteJobs;
  readonly untracked = this.reviewSvc.untracked;
  readonly incompleteJobsCount = this.reviewSvc.incompleteJobsCount;
  readonly untrackedCount = this.reviewSvc.untrackedCount;
  readonly orphanRows = this.reviewSvc.orphanRows;
  readonly artistImages = this.reviewSvc.artistImages;
  readonly artistImageCoverageRatio = this.reviewSvc.artistImageCoverageRatio;
  readonly orphanRowCount = this.reviewSvc.orphanRowCount;
  readonly playEventCount = this.reviewSvc.playEventCount;
  readonly analysis = this.reviewSvc.analysis;
  readonly reviewHeldCount = this.reviewSvc.reviewHeldCount;
  readonly reviewHeldOldestDays = this.reviewSvc.reviewHeldOldestDays;

  private readonly reviewDispose?: () => void;
  private processingStatus = signal<ProcessingStatus | null>(null);
  readonly processingStatusReadonly = this.processingStatus.asReadonly();
  constructor() {
    const dispose = this.reviewSvc.start();
    this.reviewDispose = dispose;
  }

  ngOnInit(): void {
    this.loadIncompleteJobs();
    this.loadProcessing();
    void this.loadQuarantineQueue();
    this.connectProcessingStream();
  }

  // --- Streaming ---

  // --- Windowed library processing ---
  processingPercent(): number {
    const s = this.processingStatus();
    return s ? progressPercent(s) : 0;
  }
  processingPhaseLabel(): string {
    const s = this.processingStatus();
    return s ? phaseLabel(s.phase) : '';
  }
  processingPending(): number {
    const s = this.processingStatus();
    return s ? totalPending(s) : 0;
  }
  /** Availability reason for a task, or '' when runnable. */
  taskUnavailable(task: ProcessingTaskId): string {
    const a = this.processingStatus()?.availability[task];
    return a === true || a === undefined ? '' : a;
  }
  /** True while a run is actively working. */
  processingRunning(): boolean {
    const s = this.processingStatus();
    return s ? isRunning(s) : false;
  }
  /** "Run now" is disabled while starting or while a run is in progress. */
  runNowDisabled(): boolean {
    return this.processingStarting() || this.processingRunning();
  }
  /** "Stop" is only meaningful while a run is in progress. */
  stopDisabled(): boolean {
    return !this.processingRunning();
  }
  /** Count of failures in the current/last run (surfaced in the progress area). */
  processingFailed(): number {
    return this.processingStatus()?.failed ?? 0;
  }

  private async loadProcessing(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getProcessing());
      this.processing.set(data.settings);
      this.processingStatus.set(data.status);
    } catch {
      /* ignore — non-admin or service unavailable */
    }
  }

  /** Live status via SSE (progress bar + snippets) — runs alongside the
   *  ServiceReview polling timer. The static summary in ServiceReview fires
   *  every 5s; the SSE provides per-batch transitions + snippets. */
  private connectProcessingStream(): void {
    const token = this.auth.token();
    if (!token) return;
    const src = new EventSource(this.server.sseUrl('/api/admin/processing/stream', token));
    this.processingStream = src;
    src.onmessage = (e) => {
      try {
        const status = JSON.parse(e.data) as ProcessingStatus;
        const prevQuarantined = this.processingStatus()?.quarantined;
        this.processingStatus.set(status);
        this.handleRunSettled(status);
        if (status.quarantined !== prevQuarantined) void this.loadQuarantineQueue();
      } catch {
        /* ignore malformed frame */
      }
    };
    src.onerror = () => {
      /* EventSource auto-reconnects; nothing to do */
    };
  }

  async saveProcessing(patch: Partial<ProcessingSettings>): Promise<void> {
    this.processingSaving.set(true);
    this.processingMessage.set(null);
    try {
      const data = await firstValueFrom(this.api.saveProcessing(patch));
      this.processing.set(data.settings);
      this.processingStatus.set(data.status);
      this.processingMessage.set({ type: 'success', text: this.i18n.t('admin.processingSaved') });
    } catch {
      this.processingMessage.set({
        type: 'error',
        text: this.i18n.t('admin.processingSaveFailed'),
      });
    } finally {
      this.processingSaving.set(false);
    }
  }
  // Local `processingSaving` — separate from any review slice.
  readonly processingSaving = signal(false);

  /** Toggle a per-task flag and persist immediately. */
  toggleProcessingTask(task: ProcessingTaskId): void {
    const current = this.processing();
    if (!current) return;
    void this.saveProcessing({
      tasks: { ...current.tasks, [task]: !current.tasks[task] },
    });
  }

  /** Per-song enrichment tasks shown in the panel (artist-image is per-artist and
   *  not a landing gate, so it's excluded here). Order matches the run order. */
  /** `labelKey` (not a pre-translated `label`) so the template's `| t` pipe
   *  keeps these reactive to a live language switch, matching every other
   *  label on this page. */
  readonly processingTaskDefs: { id: ProcessingTaskId; labelKey: string }[] = [
    { id: 'bpm', labelKey: 'admin.taskBpm' },
    { id: 'genre', labelKey: 'admin.taskGenre' },
    { id: 'key', labelKey: 'admin.taskKey' },
    { id: 'energy', labelKey: 'admin.taskEnergy' },
    { id: 'audio-features', labelKey: 'admin.taskAudioFeatures' },
    { id: 'descriptors', labelKey: 'admin.taskDescriptors' },
    { id: 'licence', labelKey: 'admin.taskLicence' },
    { id: 'genre-discogs', labelKey: 'admin.taskGenreDiscogs' },
    { id: 'genre-audio', labelKey: 'admin.taskGenreAudio' },
    { id: 'popularity', labelKey: 'admin.taskPopularity' },
    { id: 'artist-origin', labelKey: 'admin.taskArtistOrigin' },
  ];

  /** Whether a task is required to finish before a download lands in the library. */
  taskGated(task: ProcessingTaskId): boolean {
    return this.processing()?.gates?.[task] ?? false;
  }

  /** Toggle a per-task "require before adding to library" gate and persist. */
  toggleProcessingGate(task: ProcessingTaskId): void {
    const current = this.processing();
    if (!current) return;
    void this.saveProcessing({
      gates: { ...current.gates, [task]: !this.taskGated(task) },
    });
  }

  /** Songs currently held back from the library awaiting their gate steps. */
  processingQuarantined(): number {
    return this.processingStatus()?.quarantined ?? 0;
  }

  /** Load the quarantine queue (per-download step badges). Best-effort. */
  private async loadQuarantineQueue(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getProcessingQueue());
      this.quarantineQueue.set(data.albums);
    } catch {
      /* ignore — non-admin or service unavailable */
    }
  }

  /**
   * When a user-initiated run settles (running → non-running), toast its outcome.
   * `sawRunning` ensures we only react to a real run, not the priming frame or a
   * no-op, and clearing `awaitingRun` here keeps background/window runs silent.
   */
  private handleRunSettled(status: ProcessingStatus): void {
    if (!this.awaitingRun) return;
    if (status.phase === 'running') {
      this.sawRunning = true;
      return;
    }
    if (this.sawRunning) {
      const outcome = runOutcomeToast(status);
      if (outcome) this.toast.show({ message: outcome.message, kind: outcome.kind });
    }
    this.awaitingRun = false;
    this.sawRunning = false;
  }

  async runProcessingNow(): Promise<void> {
    if (this.runNowDisabled()) return;
    this.processingStarting.set(true);
    this.awaitingRun = true;
    this.sawRunning = false;
    try {
      await firstValueFrom(this.api.runProcessing());
      this.toast.show({ message: this.i18n.t('admin.processingStarted'), kind: 'info' });
    } catch {
      this.awaitingRun = false;
      this.toast.show({ message: this.i18n.t('admin.processingStartFailed'), kind: 'error' });
    } finally {
      this.processingStarting.set(false);
    }
  }

  async stopProcessing(): Promise<void> {
    try {
      await firstValueFrom(this.api.stopProcessing());
      this.toast.show({ message: this.i18n.t('admin.stopping'), kind: 'info' });
    } catch {
      /* ignore */
    }
  }

  // --- Library maintenance: find duplicates ---
  async loadDuplicates(): Promise<void> {
    this.duplicatesLoading.set(true);
    this.duplicatesMessage.set(null);
    this.duplicates.set([]);
    this.duplicatesDeleteSet.set(new Set());
    try {
      const groups = await firstValueFrom(this.libraryApi.getDuplicates());
      this.duplicates.set(groups);
      if (groups.length === 0) {
        this.duplicatesMessage.set({
          type: 'success',
          text: this.i18n.t('admin.noDuplicatesFound'),
        });
      } else {
        const toDelete = new Set<string>();
        for (const group of groups) {
          for (const song of group.slice(1)) toDelete.add(song.id);
        }
        this.duplicatesDeleteSet.set(toDelete);
      }
    } catch (err) {
      this.duplicatesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : this.i18n.t('admin.loadDuplicatesFailed'),
      });
    } finally {
      this.duplicatesLoading.set(false);
    }
  }

  toggleDuplicateDelete(id: string): void {
    const current = new Set(this.duplicatesDeleteSet());
    if (current.has(id)) current.delete(id);
    else current.add(id);
    this.duplicatesDeleteSet.set(current);
  }

  isDuplicateMarked(id: string): boolean {
    return this.duplicatesDeleteSet().has(id);
  }

  async deleteMarkedDuplicates(): Promise<void> {
    const ids = [...this.duplicatesDeleteSet()];
    if (ids.length === 0) return;
    this.deletingDuplicates.set(true);
    this.duplicatesMessage.set(null);
    try {
      const result = await firstValueFrom(this.libraryApi.deleteSongs(ids));
      this.duplicatesMessage.set({
        type: 'success',
        text: this.i18n.t(
          result.deletedCount === 1 ? 'admin.deletedFilesSingular' : 'admin.deletedFilesPlural',
          { count: result.deletedCount },
        ),
      });
      await this.loadDuplicates();
    } catch (err) {
      this.duplicatesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : this.i18n.t('admin.deleteFailed'),
      });
    } finally {
      this.deletingDuplicates.set(false);
    }
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  async loadIncompleteJobs(): Promise<void> {
    try {
      // `incompleteJobs` here is the ServiceReview computed slice (read-only);
      // refreshing the service re-reads on the next 5s tick. This is a no-op
      // alias kept so existing spec callers still invoke a method.
      void this.reviewSvc.incompleteJobs();
    } catch {
      /* ServiceReview already swallows — keep graceful */
    }
  }

  // ── Configuration export / import (issue #221) ──────────────────────────

  /** Issue #314 — in-app remediation for the fragments report. One busy flag
   *  serializes the actions; every action refreshes the report afterwards so
   *  the operator watches the defect list converge. */
  readonly fragmentsBusy = signal(false);
  /** Two-click delete arm state (albumId), the marked-duplicates discipline. */
  readonly fragmentsDeleteArmed = signal<string | null>(null);
  readonly missplitState = signal<{
    key: string;
    albumArtist: string;
    members: Array<MissplitMember & { selected: boolean }>;
  } | null>(null);

  private async runFragmentsAction(action: () => Promise<void>): Promise<void> {
    if (this.fragmentsBusy()) return;
    this.fragmentsBusy.set(true);
    this.fragmentsError.set(null);
    try {
      await action();
      this.fragments.set(await firstValueFrom(this.libraryApi.getFragments()));
    } catch (err) {
      this.fragmentsError.set(
        err instanceof Error ? err.message : this.i18n.t('admin.fragmentsLoadFailed'),
      );
    } finally {
      this.fragmentsBusy.set(false);
    }
  }

  /** Merge every other spelling of the cluster into `canonical` (the
   *  human-gated alias path the server's identity fix owns). */
  async mergeDuplicateCluster(
    cluster: LibraryDuplicateAlbumCluster,
    canonical: string,
  ): Promise<void> {
    await this.runFragmentsAction(async () => {
      for (const spelling of cluster.artistSpellings) {
        if (spelling.name === canonical) continue;
        await firstValueFrom(
          this.libraryApi.fixArtistIdentity({ rawName: spelling.name, mergeInto: canonical }),
        );
      }
    });
  }

  async reclassifyFragmentRow(row: LibraryHiddenByClassification): Promise<void> {
    await this.runFragmentsAction(async () => {
      await firstValueFrom(this.libraryApi.reclassifyAlbum(row.albumId, 'album'));
    });
  }

  async unhideFragmentRow(row: LibraryHiddenByClassification): Promise<void> {
    await this.runFragmentsAction(async () => {
      await firstValueFrom(this.libraryApi.unhideAlbum(row.albumId));
    });
  }

  async deleteFragmentRow(row: LibraryHiddenByClassification): Promise<void> {
    if (this.fragmentsDeleteArmed() !== row.albumId) {
      this.fragmentsDeleteArmed.set(row.albumId);
      return;
    }
    this.fragmentsDeleteArmed.set(null);
    await this.runFragmentsAction(async () => {
      await firstValueFrom(this.libraryApi.deleteAlbum(row.albumId));
    });
  }

  /** Open the mis-split preview: the curator sees every same-title album and
   *  deselects generic-title false positives before anything is written. */
  async openMissplit(finding: LibraryFragmentFinding): Promise<void> {
    if (this.fragmentsBusy()) return;
    this.fragmentsBusy.set(true);
    try {
      const preview = await firstValueFrom(this.libraryApi.missplitPreview(finding.subject));
      this.missplitState.set({
        key: finding.subject,
        albumArtist: preview.suggestedAlbumArtist,
        members: preview.members.map((m) => ({
          ...m,
          // Members already carrying the target albumArtist need no retag.
          selected: m.artist !== preview.suggestedAlbumArtist,
        })),
      });
    } catch (err) {
      this.fragmentsError.set(
        err instanceof Error ? err.message : this.i18n.t('admin.fragmentsLoadFailed'),
      );
    } finally {
      this.fragmentsBusy.set(false);
    }
  }

  toggleMissplitMember(albumId: string): void {
    const state = this.missplitState();
    if (!state) return;
    this.missplitState.set({
      ...state,
      members: state.members.map((m) =>
        m.albumId === albumId ? { ...m, selected: !m.selected } : m,
      ),
    });
  }

  setMissplitAlbumArtist(value: string): void {
    const state = this.missplitState();
    if (state) this.missplitState.set({ ...state, albumArtist: value });
  }

  async applyMissplit(): Promise<void> {
    const state = this.missplitState();
    if (!state) return;
    const ids = state.members.filter((m) => m.selected).map((m) => m.albumId);
    const albumArtist = state.albumArtist.trim();
    if (ids.length === 0 || !albumArtist) return;
    await this.runFragmentsAction(async () => {
      await firstValueFrom(this.libraryApi.missplitMerge(ids, albumArtist));
      this.missplitState.set(null);
    });
  }

  async loadFragments(): Promise<void> {
    if (this.loadingFragments()) return;
    this.loadingFragments.set(true);
    this.fragmentsError.set(null);
    try {
      this.fragments.set(await firstValueFrom(this.libraryApi.getFragments()));
    } catch (err) {
      this.fragmentsError.set(
        err instanceof Error ? err.message : this.i18n.t('admin.fragmentsLoadFailed'),
      );
      this.fragments.set(null);
    } finally {
      this.loadingFragments.set(false);
    }
  }

  async syncLibrary(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);
    this.syncMsg.set(null);
    try {
      await firstValueFrom(this.libraryApi.resyncLibrary());
      this.syncMsg.set(this.i18n.t('admin.syncComplete'));
      await this.reviewSvc.refresh();
    } catch (err) {
      this.syncMsg.set(err instanceof Error ? err.message : this.i18n.t('admin.syncFailed'));
    } finally {
      this.syncing.set(false);
    }
  }

  /** Live maintenance pass, from the shared 5s ServiceReview poll. */
  readonly maintenance = this.reviewSvc.maintenance;

  maintenanceRunning(): boolean {
    return isMaintenanceRunning(this.maintenance());
  }

  optimizeRunning(): boolean {
    return isTaskRunning(this.maintenance(), 'metadata-optimize');
  }

  /** Any pass blocks the others — they contend for the same DB and disk. */
  optimizeMetadataDisabled(): boolean {
    return this.optimizeStarting() || this.maintenanceRunning();
  }

  cancelMaintenanceDisabled(): boolean {
    return !this.maintenanceRunning();
  }

  maintenanceProgressPercent(): number {
    const m = this.maintenance();
    return m ? maintenanceProgressPercent(m) : 0;
  }

  maintenanceDetail(): Array<[string, number]> {
    return detailPairs(this.maintenance());
  }

  /** How the last pass ended, already translated; null while running. */
  maintenanceOutcomeMsg(): string | null {
    const o = maintenanceOutcome(this.maintenance());
    return o ? this.i18n.t(o.key, o.params) : null;
  }

  async optimizeAllMetadata(): Promise<void> {
    if (this.optimizeMetadataDisabled()) return;
    this.optimizeStarting.set(true);
    this.optimizeMetadataMsg.set(null);
    try {
      await firstValueFrom(this.libraryApi.startMaintenance('metadata-optimize'));
      this.optimizeMetadataMsg.set(this.i18n.t('admin.maintenanceStarted'));
      // Don't wait up to 5s for the next poll to show the pass as running.
      void this.reviewSvc.refresh();
    } catch (err) {
      // The old copy blamed Lidarr for every failure, including a plain 409.
      const status = (err as { status?: number }).status;
      this.optimizeMetadataMsg.set(
        this.i18n.t(
          status === 409
            ? 'admin.maintenanceBusy'
            : status === 503
              ? 'admin.metadataOptimizeUnavailable'
              : 'admin.metadataOptimizeFailed',
        ),
      );
    } finally {
      this.optimizeStarting.set(false);
    }
  }

  async cancelMaintenance(): Promise<void> {
    if (this.cancelMaintenanceDisabled()) return;
    try {
      await firstValueFrom(this.libraryApi.cancelMaintenance());
      void this.reviewSvc.refresh();
    } catch {
      this.optimizeMetadataMsg.set(this.i18n.t('admin.maintenanceCancelFailed'));
    }
  }

  retryHunt(job: IncompleteAlbumJob): void {
    if (job.lidarrAlbumId == null) return;
    this.retryArtist.set(job.artistName ?? '');
    this.retryAlbum.set({
      lidarrId: job.lidarrAlbumId,
      title: job.albumTitle ?? job.directory,
      foreignAlbumId: '',
      albumType: 'Album',
      secondaryTypes: [],
      totalTracks: 0,
      localTrackCount: 0,
      status: 'partial',
      tracks: [],
    });
  }

  onRetryClosed(): void {
    this.retryAlbum.set(null);
  }

  onRetryDownloaded(): void {
    this.retryAlbum.set(null);
    setTimeout(() => this.reviewSvc.refresh(), 1500);
  }

  jobStateClass(state: string): string {
    if (state === 'exhausted') return 'text-status-error';
    if (state === 'active') return 'text-status-warn';
    return 'text-theme-secondary';
  }

  formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleDateString();
  }

  ngOnDestroy(): void {
    if (this.reviewDispose) this.reviewDispose();
    this.processingStream?.close();
    this.processingStream = null;
  }

  /** Template helper for backups row template — kept as a no-op alias so
   *  existing template expressions continue to compile. */
  trackBackupName = (_: number, b: BackupInfo) => b.name;
  /** Same idea for the new Incomplete / Untracked tables. */
  trackJobId = (_: number, j: IncompleteAlbumJob) => j.id;
  trackUntracked = (_: number, u: UntrackedDownload) => u.transferKey;
}
