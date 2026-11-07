import { Component, computed, inject, signal, viewChild, type ElementRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SearchComponent } from '../search/search.component';
import { DownloadsComponent } from '../downloads/downloads.component';
import { AcquireService } from '../../services/acquire.service';
import { TransferService } from '../../services/transfer.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import {
  ImportDropCardComponent,
  albumCountOf,
  type ImportDropState,
  type ImportDropSummary,
} from '../../components/import-drop-card/import-drop-card.component';
import { ImportEntryComponent } from '../../components/import-entry/import-entry.component';
import { IconComponent } from '../../components/icon/icon.component';
import { ImportUploadService, NothingToUploadError } from '../../services/import-upload.service';
import { filesFromDataTransfer, filesFromInput } from '../../lib/dropped-files';
import { buildUploadManifest, type DroppedFile } from '../../lib/upload-plan';
import { httpErrorMessage } from '../../lib/http-error';

export type GetTab = 'add' | 'activity';

/**
 * One verb for putting music in — **add** — and one honest noun for the feed.
 *
 * The feed now carries peer downloads, link jobs *and* imports; calling it
 * "Downloads" made the card that says 📁 Imported sit under a heading claiming
 * it was downloaded (#664). The nav already said "Add"; the page did not.
 */
const TABS: ReadonlyArray<{ value: GetTab; label: string; testid: string }> = [
  { value: 'add', label: 'get.tab.add', testid: 'get-tab-find' },
  { value: 'activity', label: 'get.tab.activity', testid: 'get-tab-downloads' },
];

/**
 * `?tab=` is free-form user input; anything unrecognized means the default.
 *
 * `find`/`downloads` stay accepted forever: `/downloads` and `/search` redirect
 * here carrying them, they are in users' bookmarks and in shared links, and a
 * renamed tab is not a reason to break a URL. The test ids keep their old names
 * for the same reason — they are a selector contract, not prose.
 */
export function parseGetTab(raw: string | null): GetTab {
  return raw === 'activity' || raw === 'downloads' ? 'activity' : 'add';
}

// ─── Component ──────────────────────────────────────────────────────
// The merged acquisition workspace: "ask for music" (Find) and "watch it
// arrive" (Downloads) are two halves of one job, so they're one nav item with
// an internal tab rather than two top-level destinations.
//
// This is deliberately a *shell*: it owns the tab bar and the `?tab=` param and
// nothing else, mounting the untouched SearchComponent/DownloadsComponent as
// children. The `@if` (never `[hidden]`) is load-bearing — destroying the
// inactive tab is what unregisters its PullToRefreshService handler (that
// service is a stack spliced on the registrant's destroy) and tears down
// SearchComponent's result poll. Swap in `[hidden]` and both leak.
//
// Tab state lives in the URL, unlike the Library page's localStorage mode,
// because "show me my downloads" has to be linkable — /downloads redirects here.
@Component({
  selector: 'app-get',
  imports: [
    SearchComponent,
    DownloadsComponent,
    TranslatePipe,
    ImportDropCardComponent,
    ImportEntryComponent,
    IconComponent,
  ],
  templateUrl: './get.component.html',
})
export class GetComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transfers = inject(TransferService);
  private readonly acquire = inject(AcquireService);
  private readonly auth = inject(AuthService);
  private readonly uploads = inject(ImportUploadService);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  readonly folderInput = viewChild<ElementRef<HTMLInputElement>>('folderInput');

  /** Import outlives the acquisition kill-switch, so this is `canImport`. */
  readonly canImport = this.auth.canImport;

  /** A drag is over the Add tab. Coarse on purpose: the whole workspace is the
   *  target, because aiming at a small rectangle with a folder is fiddly. */
  readonly dragging = signal(false);
  private dragDepth = 0;

  readonly dropped = signal<DroppedFile[] | null>(null);
  readonly dropState = signal<ImportDropState>('manifest');
  readonly dropPercent = signal(0);
  readonly dropError = signal<string | null>(null);

  readonly dropSummary = computed<ImportDropSummary | null>(() => {
    const files = this.dropped();
    if (!files) return null;
    const plan = buildUploadManifest(files);
    return {
      fileCount: plan.files.length,
      albumCount: albumCountOf(plan.files.map((f) => f.path)),
      totalBytes: plan.totalBytes,
      skipped: plan.skipped,
    };
  });

  readonly tabs = TABS;
  readonly tab = signal<GetTab>(parseGetTab(this.route.snapshot.queryParamMap.get('tab')));

  /** Import is an Add-tab action (#1664); `canImport` is the role bar. */
  readonly acceptsDrop = computed(() => this.canImport() && this.tab() === 'add');

  /**
   * What Activity shows of an upload started on Add: the page owns it, so it
   * keeps running across the switch. A failure is shown too, so it is not
   * silently stranded on a tab the user left; a manifest awaiting confirmation
   * is not — nothing is happening yet.
   */
  readonly backgroundImport = computed(() => {
    const summary = this.dropSummary();
    const state = this.dropState();
    if (!summary || state === 'manifest') return null;
    return { state, percent: this.dropPercent(), albumCount: summary.albumCount };
  });

  // Same formula both nav badges use — slskd transfers, in-flight URL
  // acquisitions, and uploads that have not become a job yet.
  readonly activeCount = computed(
    () =>
      this.transfers.activeDownloadCount() +
      this.acquire.activeJobs().length +
      this.uploads.inFlight(),
  );

  // Drag events fire per element, so a naive enter/leave pair flickers as the
  // pointer crosses children. Counting depth is the standard fix.
  onDragEnter(e: DragEvent): void {
    if (!this.acceptsDrop() || !e.dataTransfer?.types.includes('Files')) return;
    this.dragDepth += 1;
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging.set(false);
  }

  onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    // Without preventDefault the browser navigates to the dropped file, which
    // discards the SPA and everything in it — so a drop this tab does not take
    // is still swallowed, just with a "no drop" cursor.
    e.preventDefault();
    e.dataTransfer.dropEffect = this.acceptsDrop() ? 'copy' : 'none';
  }

  async onDrop(e: DragEvent): Promise<void> {
    this.dragDepth = 0;
    this.dragging.set(false);
    if (!e.dataTransfer) return;
    e.preventDefault();
    if (!this.acceptsDrop()) return;
    this.stageFiles(await filesFromDataTransfer(e.dataTransfer));
  }

  pickFolder(): void {
    this.folderInput()?.nativeElement.click();
  }

  onFolderPicked(e: Event): void {
    const el = e.target as HTMLInputElement;
    const files = el.files ? filesFromInput(el.files) : [];
    // Clear so re-picking the same folder fires `change` again.
    el.value = '';
    this.stageFiles(files);
  }

  /** Show the manifest and wait — a drop is a proposal, not a command. */
  private stageFiles(files: DroppedFile[]): void {
    if (files.length === 0) return;
    this.dropState.set('manifest');
    this.dropPercent.set(0);
    this.dropError.set(null);
    this.dropped.set(files);
  }

  async startImport(): Promise<void> {
    const files = this.dropped();
    if (!files) return;
    this.dropState.set('uploading');
    this.dropError.set(null);
    try {
      await this.uploads.upload(files, {
        onProgress: (p) => this.dropPercent.set(p),
        onCommitting: () => this.dropState.set('committing'),
      });
      // The job now owns this work — the feed is where it lives from here, so
      // the card retires rather than shadowing a Downloads row (#673's shape).
      this.dismissDrop();
      await this.transfers.kickPoll();
      this.setTab('activity');
    } catch (err) {
      this.dropState.set('error');
      this.dropError.set(
        err instanceof NothingToUploadError
          ? this.i18n.t('import.dropNothing')
          : httpErrorMessage(err, this.i18n.t('import.dropFailed')),
      );
    }
  }

  dismissDrop(): void {
    this.dropped.set(null);
    this.dropState.set('manifest');
    this.dropPercent.set(0);
    this.dropError.set(null);
  }

  setTab(tab: GetTab): void {
    if (this.tab() === tab) return;
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
