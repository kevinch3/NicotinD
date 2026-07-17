import { Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';

interface BottomNavItem {
  to: string;
  label: string;
  /** Disabled when offline (route needs the backend). */
  onlineOnly: boolean;
}

// Curated mobile tab order (Admin intentionally stays desktop-only to keep the
// bar to thumb-reachable targets). Search is online-only because /search needs
// the backend (network browse + URL acquire).
const TABS: BottomNavItem[] = [
  { to: '/', label: 'Home', onlineOnly: true },
  { to: '/library', label: 'Library', onlineOnly: false },
  { to: '/downloads', label: 'Downloads', onlineOnly: false },
  { to: '/search', label: 'Search', onlineOnly: true },
  { to: '/settings', label: 'Settings', onlineOnly: false },
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
  imports: [RouterLink, RouterLinkActive, NgTemplateOutlet],
  templateUrl: './bottom-nav.component.html',
})
export class BottomNavComponent {
  readonly setup = inject(SetupService);
  private transfers = inject(TransferService);
  private auth = inject(AuthService);

  // Downloads is an acquisition surface — hidden from listeners (declutter).
  readonly tabs = computed(() =>
    this.auth.canAcquire() ? TABS : TABS.filter((t) => t.to !== '/downloads'),
  );
  readonly activeDownloads = this.transfers.activeDownloadCount;

  isDisabled(tab: BottomNavItem): boolean {
    return tab.onlineOnly && this.setup.isOffline();
  }
}
