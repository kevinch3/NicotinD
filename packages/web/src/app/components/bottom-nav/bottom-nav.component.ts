import { Component, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';

interface BottomNavItem {
  to: string;
  label: string;
  /** Disabled when offline (route needs the backend). */
  onlineOnly: boolean;
}

// Curated mobile tab order (Admin intentionally stays in the hamburger drawer to
// keep the bar to four thumb-reachable targets).
const TABS: BottomNavItem[] = [
  { to: '/', label: 'Search', onlineOnly: true },
  { to: '/library', label: 'Library', onlineOnly: true },
  { to: '/downloads', label: 'Downloads', onlineOnly: false },
  { to: '/settings', label: 'Settings', onlineOnly: false },
];

/**
 * Persistent bottom tab bar shown only on mobile (`md:hidden`). Sits at the very
 * bottom of the viewport; the mini-player floats just above it (the player is
 * shifted up by the bar's height on mobile), and the full-screen Now Playing
 * sheet (higher z-index) covers it when open.
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

  readonly tabs = TABS;
  readonly activeDownloads = this.transfers.activeDownloadCount;

  isDisabled(tab: BottomNavItem): boolean {
    return tab.onlineOnly && this.setup.isOffline();
  }
}
