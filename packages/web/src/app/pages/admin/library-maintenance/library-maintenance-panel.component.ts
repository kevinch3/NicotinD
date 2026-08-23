import { Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { AlbumHuntModalComponent } from '../../../components/album-hunt-modal/album-hunt-modal.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import type {
  DiscographyAlbum,
  IncompleteAlbumJob,
  LibraryDuplicateAlbumCluster,
  LibraryFragmentFinding,
  LibraryFragmentReport,
  LibraryHiddenByClassification,
  MissplitMember,
} from '../../../services/api/api-types';
import {
  detailPairs,
  isMaintenanceRunning,
  isTaskRunning,
  maintenanceOutcome,
  maintenanceProgressPercent as computeMaintenanceProgressPercent,
} from '../../../lib/maintenance-progress';
import { ServiceReviewService } from '../../../services/service-review.service';
import { TranslateService } from '../../../services/translate.service';

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

/**
 * Admin card for library maintenance: whole-library passes (resync, metadata
 * optimize), duplicate finding, the fragmentation report and its remediations,
 * orphan/artist-image/play-event counters, and the incomplete/untracked job
 * tables with their retry-hunt modal.
 *
 * Every counter here is a `ServiceReview` slice, so the panel starts no poll of
 * its own; the action buttons ask for a refresh, which coalesces.
 */
@Component({
  selector: 'app-library-maintenance-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [
    SettingsGroupComponent,
    AlbumHuntModalComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './library-maintenance-panel.component.html',
})
export class LibraryMaintenancePanelComponent {
  private readonly api = inject(SystemApiService);
  private readonly libraryApi = inject(LibraryApiService);
  readonly i18n = inject(TranslateService);
  protected readonly reviewSvc = inject(ServiceReviewService);

  readonly maintenance = this.reviewSvc.maintenance;
  readonly incompleteJobs = this.reviewSvc.incompleteJobs;
  readonly incompleteJobsCount = this.reviewSvc.incompleteJobsCount;
  readonly untracked = this.reviewSvc.untracked;
  readonly untrackedCount = this.reviewSvc.untrackedCount;
  readonly orphanRows = this.reviewSvc.orphanRows;
  readonly orphanRowCount = this.reviewSvc.orphanRowCount;
  readonly artistImages = this.reviewSvc.artistImages;
  readonly artistImageCoverageRatio = this.reviewSvc.artistImageCoverageRatio;
  readonly playEventCount = this.reviewSvc.playEventCount;

  readonly optimizeStarting = signal(false);
  readonly optimizeMetadataMsg = signal<string | null>(null);
  readonly syncing = signal(false);
  readonly syncMsg = signal<string | null>(null);

  readonly loadingFragments = signal(false);
  readonly fragments = signal<LibraryFragmentReport | null>(null);
  readonly fragmentsError = signal<string | null>(null);
  readonly fragmentsBusy = signal(false);
  readonly fragmentsDeleteArmed = signal<string | null>(null);

  readonly duplicatesLoading = signal(false);
  readonly duplicates = signal<DuplicateSong[][]>([]);
  readonly duplicatesDeleteSet = signal<Set<string>>(new Set());
  readonly duplicatesMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly deletingDuplicates = signal(false);

  readonly retryAlbum = signal<DiscographyAlbum | null>(null);
  readonly retryArtist = signal('');

  readonly missplitState = signal<{
    key: string;
    albumArtist: string;
    members: Array<MissplitMember & { selected: boolean }>;
  } | null>(null);

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
    return m ? computeMaintenanceProgressPercent(m) : 0;
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
}
