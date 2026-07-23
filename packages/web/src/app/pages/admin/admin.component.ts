import { Component, inject, signal, effect, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { ProcessingSettings, ProcessingStatus, ProcessingTaskId } from '../../../types/core';
import { ROLES, type Role } from '../../../types/core';
import { SystemApiService } from '../../services/api/system-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ServiceReviewService } from '../../services/service-review.service';
import type {
  AdminUser,
  BackupInfo,
  IncompleteAlbumJob,
  QuarantineAlbum,
  SongSteps,
  LibraryFragmentReport,
  StreamingSettings,
  UntrackedDownload,
} from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { ToastService } from '../../services/toast.service';
import {
  progressPercent,
  phaseLabel,
  totalPending,
  isRunning,
  runOutcomeToast,
} from '../../lib/processing-progress';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';
import { MetricPillComponent } from '../../components/metric-pill/metric-pill.component';
import { DiscographyAlbum } from '../../services/api/api-types';

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
  imports: [FormsModule, PasswordFieldComponent, AlbumHuntModalComponent, MetricPillComponent],
  templateUrl: './admin.component.html',
})
export class AdminComponent implements OnInit, OnDestroy {
  private api = inject(SystemApiService);
  private downloadsApi = inject(DownloadsApiService);
  private libraryApi = inject(LibraryApiService);
  private auth = inject(AuthService);
  private server = inject(ServerConfigService);
  private toast = inject(ToastService);
  /** One consolidated snapshot for every read-only Admin telemetry — replaces
   *  the per-section loaders the page used to manage (systemStatus, scanStatus,
   *  updateCheck, backups, auditLog, incompleteJobs, untracked, hardware metrics).
   *  Write actions (settings forms, restart, run-now, etc.) keep their own
   *  PATCH-shape endpoints; this service is the snapshot companion. */
  protected readonly reviewSvc = inject(ServiceReviewService);

  readonly services: 'slskd'[] = ['slskd'];

  readonly users = signal<AdminUser[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly resetTarget = signal<AdminUser | null>(null);
  readonly newPassword = signal('');
  readonly resetting = signal(false);

  readonly deleteTarget = signal<AdminUser | null>(null);
  readonly deleting = signal(false);

  readonly showCreateUser = signal(false);
  readonly newUsername = signal('');
  readonly newUserPassword = signal('');
  readonly creating = signal(false);

  readonly restarting = signal<{ slskd: boolean }>({ slskd: false });

  // Library-wide metadata optimization (cover/year/release-type from Lidarr).
  readonly optimizingMetadata = signal(false);
  readonly optimizeMetadataMsg = signal<string | null>(null);

  // Action-only loaders (snapshot equivalents drain from ServiceReviewService).
  readonly syncing = signal(false);
  readonly syncMsg = signal<string | null>(null);

  readonly checkingUpdate = signal(false);

  readonly backingUp = signal(false);
  readonly backupMsg = signal<string | null>(null);

  readonly loadingFragments = signal(false);
  readonly fragments = signal<LibraryFragmentReport | null>(null);
  readonly fragmentsError = signal<string | null>(null);

  readonly streaming = signal<StreamingSettings | null>(null);
  readonly streamingSaving = signal(false);
  readonly streamingMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

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

  readonly selectedService = signal<'slskd' | 'nicotind'>('nicotind');
  readonly logLines = signal<string[]>([]);
  readonly logStreamStatus = signal<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle');

  // ServiceReview slices — exposed for the template.
  readonly cpu = this.reviewSvc.cpu;
  readonly memory = this.reviewSvc.memory;
  readonly gpu = this.reviewSvc.gpu;
  readonly servicesState = this.reviewSvc.services;
  readonly libraryState = this.reviewSvc.libraryState;
  readonly updateCheck = this.reviewSvc.updateCheck;
  readonly backups = this.reviewSvc.backups;
  readonly backupsSummary = this.reviewSvc.backupsSummary;
  readonly auditTail = this.reviewSvc.auditTail;
  readonly incompleteJobs = this.reviewSvc.incompleteJobs;
  readonly untracked = this.reviewSvc.untracked;
  readonly incompleteJobsCount = this.reviewSvc.incompleteJobsCount;
  readonly untrackedCount = this.reviewSvc.untrackedCount;

  private logEventSource: EventSource | null = null;
  private logReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reviewDispose?: () => void;
  private processingStatus = signal<ProcessingStatus | null>(null);
  readonly processingStatusReadonly = this.processingStatus.asReadonly();
  private readonly serviceSelectEffect = effect(() => {
    this.selectedService();
    this.connectLogStream();
  });

  constructor() {
    const dispose = this.reviewSvc.start();
    this.reviewDispose = dispose;
  }

  currentUserId(): string | null {
    const token = this.auth.token();
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub as string;
    } catch {
      return null;
    }
  }

  ngOnInit(): void {
    this.loadUsers();
    this.loadIncompleteJobs();
    this.loadStreaming();
    this.loadProcessing();
    void this.loadQuarantineQueue();
    this.connectProcessingStream();
  }

  // --- Streaming ---
  private async loadStreaming(): Promise<void> {
    try {
      this.streaming.set(await firstValueFrom(this.api.getStreamingSettings()));
    } catch {
      /* ignore */
    }
  }

  async saveStreaming(patch: Partial<StreamingSettings>): Promise<void> {
    this.streamingSaving.set(true);
    this.streamingMessage.set(null);
    try {
      this.streaming.set(await firstValueFrom(this.api.saveStreamingSettings(patch)));
      this.streamingMessage.set({ type: 'success', text: 'Streaming settings saved' });
    } catch {
      this.streamingMessage.set({ type: 'error', text: 'Failed to save streaming settings' });
    } finally {
      this.streamingSaving.set(false);
    }
  }

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
    const src = new EventSource(
      this.server.apiUrl(`/api/admin/processing/stream?token=${encodeURIComponent(token)}`),
    );
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
      this.processingMessage.set({ type: 'success', text: 'Processing settings saved' });
    } catch {
      this.processingMessage.set({ type: 'error', text: 'Failed to save processing settings' });
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
  readonly processingTaskDefs: { id: ProcessingTaskId; label: string }[] = [
    { id: 'bpm', label: 'BPM analysis' },
    { id: 'genre', label: 'Genre' },
    { id: 'key', label: 'Musical key' },
    { id: 'energy', label: 'Energy & loudness' },
    { id: 'audio-features', label: 'Audio features (mood, valence, danceability)' },
    { id: 'licence', label: 'Licence / rights (tags → MusicBrainz)' },
    { id: 'genre-audio', label: 'Genre (audio fallback)' },
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
      this.toast.show({ message: 'Processing started', kind: 'info' });
    } catch {
      this.awaitingRun = false;
      this.toast.show({ message: 'Failed to start processing', kind: 'error' });
    } finally {
      this.processingStarting.set(false);
    }
  }

  async stopProcessing(): Promise<void> {
    try {
      await firstValueFrom(this.api.stopProcessing());
      this.toast.show({ message: 'Stopping…', kind: 'info' });
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
        this.duplicatesMessage.set({ type: 'success', text: 'No duplicates found' });
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
        text: err instanceof Error ? err.message : 'Failed to load duplicates',
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
        text: `Deleted ${result.deletedCount} file${result.deletedCount !== 1 ? 's' : ''}`,
      });
      await this.loadDuplicates();
    } catch (err) {
      this.duplicatesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete',
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

  /** Manual "Check now" — forces a fresh GitHub poll (the data is then
   *  re-picked up by ServiceReview on the next 5s tick; we also refresh
   *  inline so the user sees the result without waiting). */
  async checkUpdateNow(): Promise<void> {
    if (this.checkingUpdate()) return;
    this.checkingUpdate.set(true);
    try {
      await firstValueFrom(this.api.getUpdateCheck(true));
      await this.reviewSvc.refresh();
    } catch {
      /* non-fatal */
    } finally {
      this.checkingUpdate.set(false);
    }
  }
  /** Local setter alias so the template's button click stays terse. */
  loadUpdateCheck(refresh = false): Promise<void> {
    return this.checkUpdateNow().then(() => undefined);
  }

  async runBackup(): Promise<void> {
    if (this.backingUp()) return;
    this.backingUp.set(true);
    this.backupMsg.set(null);
    try {
      const info = await firstValueFrom(this.api.runBackup());
      this.backupMsg.set(`Backup ${info.name} created (${this.formatBackupSize(info.sizeBytes)}).`);
      await this.reviewSvc.refresh();
    } catch {
      this.backupMsg.set('Backup failed — see server logs.');
    } finally {
      this.backingUp.set(false);
    }
  }

  formatBackupSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  formatBackupDate(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  async loadFragments(): Promise<void> {
    if (this.loadingFragments()) return;
    this.loadingFragments.set(true);
    this.fragmentsError.set(null);
    try {
      this.fragments.set(await firstValueFrom(this.libraryApi.getFragments()));
    } catch (err) {
      this.fragmentsError.set(
        err instanceof Error ? err.message : 'Failed to load fragmentation report.',
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
      this.syncMsg.set('Library rescan complete.');
      await this.reviewSvc.refresh();
    } catch (err) {
      this.syncMsg.set(
        err instanceof Error ? err.message : 'Library rescan failed — is the server configured?',
      );
    } finally {
      this.syncing.set(false);
    }
  }

  async optimizeAllMetadata(): Promise<void> {
    if (this.optimizingMetadata()) return;
    this.optimizingMetadata.set(true);
    this.optimizeMetadataMsg.set(null);
    try {
      const r = await firstValueFrom(this.libraryApi.optimizeAllMetadata());
      this.optimizeMetadataMsg.set(
        `Checked ${r.albums} album(s): ${r.coversUpdated} cover(s), ${r.yearsUpdated} year(s) updated.`,
      );
    } catch {
      this.optimizeMetadataMsg.set('Failed — Lidarr unavailable or not configured.');
    } finally {
      this.optimizingMetadata.set(false);
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
    this.disconnectLogStream();
    this.processingStream?.close();
    this.processingStream = null;
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr + 'Z').toLocaleDateString();
  }

  formatAuditTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  getBadgeColor(svc: 'slskd'): string {
    const status = this.servicesState();
    if (!status) return 'text-theme-muted';
    const health = status.slskd;
    const connected = health.connected;
    return connected
      ? 'text-status-done'
      : health.healthy
        ? 'text-status-warn'
        : 'text-status-error';
  }

  getDotColor(svc: 'slskd'): string {
    const status = this.servicesState();
    if (!status) return 'bg-theme-muted';
    const health = status.slskd;
    const connected = health.connected;
    return connected ? 'bg-emerald-500' : health.healthy ? 'bg-amber-400' : 'bg-red-500';
  }

  getBadgeLabel(svc: 'slskd'): string {
    const status = this.servicesState();
    if (!status) return '—';
    const health = status.slskd;
    const connected = health.connected;
    return connected ? 'Connected' : health.healthy ? 'Disconnected' : 'Unreachable';
  }

  readonly roles = ROLES;

  async setRole(user: AdminUser, newRole: Role): Promise<void> {
    if (newRole === user.role) return;
    const prevRole = user.role;
    this.users.update((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)));
    try {
      await firstValueFrom(this.api.updateUserRole(user.id, newRole));
    } catch (err) {
      this.users.update((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, role: prevRole } : u)),
      );
      this.error.set(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  async toggleStatus(user: AdminUser): Promise<void> {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    try {
      await firstValueFrom(this.api.updateUserStatus(user.id, newStatus as 'active' | 'disabled'));
      this.users.update((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, status: newStatus } : u)),
      );
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  async handleResetPassword(): Promise<void> {
    const target = this.resetTarget();
    if (!target || !this.newPassword().trim()) return;
    this.resetting.set(true);
    try {
      await firstValueFrom(this.api.resetUserPassword(target.id, this.newPassword().trim()));
      this.resetTarget.set(null);
      this.newPassword.set('');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      this.resetting.set(false);
    }
  }

  async handleCreateUser(): Promise<void> {
    const username = this.newUsername().trim();
    const password = this.newUserPassword().trim();
    if (!username || !password) return;
    this.creating.set(true);
    try {
      const user = await firstValueFrom(this.api.createUser(username, password));
      this.users.update((prev) => [...prev, user]);
      this.showCreateUser.set(false);
      this.newUsername.set('');
      this.newUserPassword.set('');
    } catch (err: any) {
      this.error.set(err.error?.error ?? err.message ?? 'Failed to create user');
    } finally {
      this.creating.set(false);
    }
  }

  async handleDeleteUser(): Promise<void> {
    const target = this.deleteTarget();
    if (!target) return;
    this.deleting.set(true);
    try {
      await firstValueFrom(this.api.deleteUser(target.id));
      this.users.update((prev) => prev.filter((u) => u.id !== target.id));
      this.deleteTarget.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      this.deleting.set(false);
    }
  }

  async handleRestart(service: 'slskd'): Promise<void> {
    this.restarting.update((prev) => ({ ...prev, [service]: true }));
    try {
      await firstValueFrom(this.api.restartService(service));
      setTimeout(() => this.reviewSvc.refresh(), 3000);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : `Failed to restart ${service}`);
    } finally {
      this.restarting.update((prev) => ({ ...prev, [service]: false }));
    }
  }

  readonly logServiceOptions: ('slskd' | 'nicotind')[] = ['slskd', 'nicotind'];

  selectLogService(svc: 'slskd' | 'nicotind'): void {
    this.selectedService.set(svc);
    this.logLines.set([]);
  }

  public connectLogStream(): void {
    const token = this.auth.token();
    if (!token) return;
    this.disconnectLogStream();
    const service = this.selectedService();
    const src = new EventSource(
      this.server.apiUrl(
        `/api/system/logs/${service}/stream?token=${encodeURIComponent(token ?? '')}`,
      ),
    );
    this.logEventSource = src;
    this.logStreamStatus.set('connecting');

    let everConnected = false;

    src.onopen = () => {
      everConnected = true;
      this.logStreamStatus.set('connected');
    };

    src.onmessage = (e) => {
      this.logLines.update((lines) => {
        const next = [...lines, e.data];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
      this.scrollLogsToBottom();
    };

    src.onerror = () => {
      src.close();
      this.logEventSource = null;
      if (everConnected) {
        this.logStreamStatus.set('connecting');
        this.logReconnectTimer = setTimeout(() => this.connectLogStream(), 5000);
      } else {
        this.logStreamStatus.set('disconnected');
      }
    };
  }

  private disconnectLogStream(): void {
    if (this.logReconnectTimer !== null) {
      clearTimeout(this.logReconnectTimer);
      this.logReconnectTimer = null;
    }
    this.logEventSource?.close();
    this.logEventSource = null;
  }

  private scrollLogsToBottom(): void {
    setTimeout(() => {
      const el = document.querySelector('.log-scroll-container');
      if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    }, 0);
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await firstValueFrom(this.api.getUsers());
      this.users.set(data);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      this.loading.set(false);
    }
  }

  /** Template helper for backups row template — kept as a no-op alias so
   *  existing template expressions continue to compile. */
  trackBackupName = (_: number, b: BackupInfo) => b.name;
  /** Same idea for the new Incomplete / Untracked tables. */
  trackJobId = (_: number, j: IncompleteAlbumJob) => j.id;
  trackUntracked = (_: number, u: UntrackedDownload) => u.transferKey;
}
