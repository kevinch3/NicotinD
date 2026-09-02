import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  ProcessingSettings,
  ProcessingStatus,
  ProcessingTaskId,
} from '../../../../types/core';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import {
  isRunning,
  phaseLabel,
  progressPercent,
  runOutcomeToast,
  totalPending,
} from '../../../lib/processing-progress';
import { AcquisitionSettingsService } from '../../../services/acquisition-settings.service';
import { AuthService } from '../../../services/auth.service';
import { ServerConfigService } from '../../../services/server-config.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { QuarantineAlbum, SongSteps } from '../../../services/api/api-types';
import { ServiceReviewService } from '../../../services/service-review.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for background library processing (docs/library-processing.md):
 * the enable/pause switches, per-task run + landing-gate flags, the
 * hold-for-review inbox toggle, and live progress over SSE.
 *
 * Reads the acquisition kill-switch from `AcquisitionSettingsService` (owned by
 * the Acquisition & automation panel) because hold-for-review needs a reachable
 * Downloads inbox — see #416 and that service's own note.
 */
@Component({
  selector: 'app-library-processing-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './library-processing-panel.component.html',
})
export class LibraryProcessingPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(SystemApiService);
  private readonly auth = inject(AuthService);
  private readonly server = inject(ServerConfigService);
  private readonly toast = inject(ToastService);
  readonly i18n = inject(TranslateService);
  private readonly reviewSvc = inject(ServiceReviewService);
  protected readonly acqSvc = inject(AcquisitionSettingsService);

  readonly analysis = this.reviewSvc.analysis;
  readonly separator = this.reviewSvc.separator;
  readonly reviewHeldCount = this.reviewSvc.reviewHeldCount;
  readonly reviewHeldOldestDays = this.reviewSvc.reviewHeldOldestDays;

  readonly processing = signal<ProcessingSettings | null>(null);
  readonly processingStarting = signal(false);
  readonly processingSaving = signal(false);
  readonly processingMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly quarantineQueue = signal<QuarantineAlbum[]>([]);

  private processingStream: EventSource | null = null;
  private processingStatus = signal<ProcessingStatus | null>(null);
  readonly processingStatusReadonly = this.processingStatus.asReadonly();
  private awaitingRun = false;
  private sawRunning = false;

  readonly stepKeys = [
    'bpm',
    'key',
    'energy',
    'genre',
    'mood',
  ] as const satisfies (keyof SongSteps)[];

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
    { id: 'genre-discogs', labelKey: 'admin.taskGenreDiscogs' },
    { id: 'genre-audio', labelKey: 'admin.taskGenreAudio' },
    { id: 'popularity', labelKey: 'admin.taskPopularity' },
    { id: 'artist-origin', labelKey: 'admin.taskArtistOrigin' },
  ];

  ngOnInit(): void {
    void this.loadProcessing();
    void this.loadQuarantineQueue();
    this.connectProcessingStream();
  }

  ngOnDestroy(): void {
    this.processingStream?.close();
    this.processingStream = null;
  }

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

  /** Toggle a per-task flag and persist immediately. */
  toggleProcessingTask(task: ProcessingTaskId): void {
    const current = this.processing();
    if (!current) return;
    void this.saveProcessing({
      tasks: { ...current.tasks, [task]: !current.tasks[task] },
    });
  }

  /** Whether a task is required to finish before a download lands in the library. */
  taskGated(task: ProcessingTaskId): boolean {
    return this.processing()?.gates?.[task] ?? false;
  }

  /**
   * Whether this task may be required before landing at all. The server declares
   * it (`ProcessingStatus.gateable`); a task that can confidently have no answer
   * for a good file must never be offered as a gate, because switching one on
   * stranded 261 songs on prod (#691 / #687). An older server omits the field —
   * fall back to showing the control rather than silently hiding every one.
   */
  taskGateable(task: ProcessingTaskId): boolean {
    const declared = this.processingStatus()?.gateable;
    return declared ? declared.includes(task) : true;
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
}
