import { Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AcquireService } from '../../services/acquire.service';
import { AuthService } from '../../services/auth.service';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';
import { DownloadReviewService } from '../../services/download-review.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

interface BottomNavItem {
  to: string;
  label: string;
  /** Disabled when offline (route needs the backend). */
  onlineOnly: boolean;
}

// Curated mobile tab order (Admin intentionally stays desktop-only to keep the
// bar to thumb-reachable targets). /get is not online-only: its Downloads tab
// works offline, and the Find tab surfaces its own offline state.
const TABS: BottomNavItem[] = [
  // `label` is an i18n key (issue #236), rendered through the `t` pipe.
  // Home is not online-only: the mosaic fills with the device's downloaded
  // tracks when the network is gone (docs/web-ui.md "Mosaic home").
  { to: '/', label: 'nav.home', onlineOnly: false },
  { to: '/library', label: 'nav.library', onlineOnly: false },
  { to: '/get', label: 'nav.get', onlineOnly: false },
  { to: '/settings', label: 'nav.settings', onlineOnly: false },
];

/**
 * Persistent bottom tab bar shown only on mobile (`md:hidden`). Sits at the very
 * bottom of the viewport; the mini-player floats just above it (the player is
 * shifted up by the bar's height on mobile), and the full-screen Now Playing
 * sheet (higher z-index) covers it when open.
 *
 * Stacking contract (the "menu + player share visibility" rule): the tab bar is
 * `z-50`, the SAME level as the mini-player. Both are bottom-chrome shell layers
 * rendered after the routed page, so a page-level modal backdrop (`z-50`,
 * e.g. the album-hunt dialog) sits *under* both — they stay visible together.
 * If they diverged (the old `z-40` bar), a modal would hide the menu while the
 * player kept showing. True full-screen sheets (Now Playing / add-to-playlist
 * `z-[60]`, context menu `z-[70]`) still cover both. Don't drop this below the
 * player's `z-50` — keep the two bottom layers on one plane.
 */
@Component({
  selector: 'app-bottom-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, NgTemplateOutlet, TranslatePipe],
  templateUrl: './bottom-nav.component.html',
  styleUrl: './bottom-nav.component.css',
})
export class BottomNavComponent {
  readonly setup = inject(SetupService);
  private transfers = inject(TransferService);
  private acquire = inject(AcquireService);
  private auth = inject(AuthService);
  private review = inject(DownloadReviewService);

  // /get is an acquisition surface — hidden from listeners (declutter).
  readonly tabs = computed(() =>
    // `canImport`, not `canAcquire`: /get still has the import drop zone when
    // the acquisition kill-switch is off, and a tab you cannot reach is worse
    // than one whose contents are reduced.
    this.auth.canImport() ? TABS : TABS.filter((t) => t.to !== '/get'),
  );
  // Same formula as the desktop nav badge: slskd transfers + in-flight URL
  // acquisitions + the download-inbox triage queue (issue #411, 0 for anyone
  // who can't curate). Mobile used to omit the acquire jobs, so a spotdl/yt-dlp
  // download showed a badge on desktop and none on the phone.
  readonly activeDownloads = computed(
    () =>
      this.transfers.activeDownloadCount() +
      this.acquire.activeJobs().length +
      this.review.pending(),
  );

  // Derived, not a fixed `grid-cols-N` class: a listener has /get filtered out,
  // so a hardcoded count leaves a trailing empty column and the tabs sit
  // off-centre. (The old bar was `grid-cols-5` with a 4-item listener case.)
  readonly gridColumns = computed(() => `repeat(${this.tabs().length}, minmax(0, 1fr))`);

  isDisabled(tab: BottomNavItem): boolean {
    return tab.onlineOnly && this.setup.isOffline();
  }
}
