import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SearchComponent } from '../search/search.component';
import { DownloadsComponent } from '../downloads/downloads.component';
import { AcquireService } from '../../services/acquire.service';
import { TransferService } from '../../services/transfer.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

export type GetTab = 'find' | 'downloads';

const TABS: ReadonlyArray<{ value: GetTab; label: string; testid: string }> = [
  { value: 'find', label: 'get.tab.find', testid: 'get-tab-find' },
  { value: 'downloads', label: 'get.tab.downloads', testid: 'get-tab-downloads' },
];

/** `?tab=` is free-form user input; anything unrecognized means the default. */
export function parseGetTab(raw: string | null): GetTab {
  return raw === 'downloads' ? 'downloads' : 'find';
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
  imports: [SearchComponent, DownloadsComponent, TranslatePipe],
  templateUrl: './get.component.html',
})
export class GetComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transfers = inject(TransferService);
  private readonly acquire = inject(AcquireService);

  readonly tabs = TABS;
  readonly tab = signal<GetTab>(parseGetTab(this.route.snapshot.queryParamMap.get('tab')));

  // Same formula the desktop nav badge uses — slskd transfers plus in-flight
  // URL acquisitions.
  readonly activeCount = computed(
    () => this.transfers.activeDownloadCount() + this.acquire.activeJobs().length,
  );

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
