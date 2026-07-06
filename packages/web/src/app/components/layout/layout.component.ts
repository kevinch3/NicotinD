import { Component, inject, computed, signal, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { APP_VERSION } from '../../app.config';
import { Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { PlayerService, shuffleArray } from '../../services/player.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { toTrack } from '../../lib/track-utils';
import { mainBottomPadClass } from '../../lib/player-chrome';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { PreserveService } from '../../services/preserve.service';
import { PlayerComponent } from '../player/player.component';
import { NowPlayingComponent } from '../now-playing/now-playing.component';
import { UpdateBannerComponent } from '../update-banner/update-banner.component';
import { WelcomeBannerComponent } from '../welcome-banner/welcome-banner.component';
import { BottomNavComponent } from '../bottom-nav/bottom-nav.component';
import { AddToPlaylistComponent } from '../add-to-playlist/add-to-playlist.component';
import { ChangelogModalComponent } from '../changelog-modal/changelog-modal.component';

interface NavItem {
  to: string;
  label: string;
}

const BASE_NAV: NavItem[] = [
  { to: '/', label: 'Search' },
  { to: '/downloads', label: 'Downloads' },
  { to: '/library', label: 'Library' },
  { to: '/settings', label: 'Settings' },
];
// Nav items that require the backend to be available
const ONLINE_ONLY_ROUTES = new Set(['/', '/library']);

@Component({
  selector: 'app-layout',
  imports: [
    FormsModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    PlayerComponent,
    NowPlayingComponent,
    UpdateBannerComponent,
    WelcomeBannerComponent,
    BottomNavComponent,
    AddToPlaylistComponent,
    ChangelogModalComponent,
  ],
  templateUrl: './layout.component.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  readonly setup = inject(SetupService);
  readonly preserve = inject(PreserveService);
  private router = inject(Router);
  readonly version = inject(APP_VERSION);
  private transfers = inject(TransferService);
  private acquire = inject(AcquireService);
  private api = inject(LibraryApiService);

  readonly navItems = computed<NavItem[]>(() =>
    this.auth.role() === 'admin' ? [...BASE_NAV, { to: '/admin', label: 'Admin' }] : BASE_NAV,
  );

  isNavDisabled(route: string): boolean {
    return this.setup.isOffline() && ONLINE_ONLY_ROUTES.has(route);
  }

  // Active download badge on the desktop "Downloads" nav link — slskd transfers
  // + in-flight URL acquisitions (the old standalone header indicator's signal,
  // folded into the nav item now that the dedicated header button is gone; the
  // mobile tab bar already carries the same badge).
  readonly downloadCount = computed(
    () => this.transfers.activeDownloadCount() + this.acquire.activeJobs().length,
  );

  // Bottom padding so fixed chrome never covers the last list item — geometry
  // shared with the mini-player/tab-bar stack in lib/player-chrome.ts.
  readonly mainPadClass = computed(() => mainBottomPadClass(this.player.currentTrack() !== null));

  readonly showChangelog = signal(false);
  readonly showLogoutDialog = signal(false);
  readonly cleanPreserveOnLogout = signal(false);

  readonly GB = 1024 * 1024 * 1024;

  formatStorage(bytes: number): string {
    if (bytes < this.GB) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    return `${(bytes / this.GB).toFixed(bytes % this.GB === 0 ? 0 : 1)} GB`;
  }

  logout(): void {
    if (this.preserve.totalUsage() > 0) {
      this.cleanPreserveOnLogout.set(false);
      this.showLogoutDialog.set(true);
    } else {
      this.auth.logout();
      this.router.navigateByUrl('/login');
    }
  }

  async confirmLogout(): Promise<void> {
    if (this.cleanPreserveOnLogout()) {
      await this.preserve.clearAll();
    }
    this.showLogoutDialog.set(false);
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }

  ngOnInit(): void {
    this.transfers.startPolling();
    // Load any in-flight URL acquisitions so the header badge reflects them
    // app-wide (AcquireService self-polls while jobs are active).
    void this.acquire.refresh();

    // Radio source: metadata-aware track selection so playback continues with
    // musically similar tracks. Falls back to shuffled recent songs when no seed.
    this.player.setRadioProvider(async (seed) => {
      if (!seed.currentTrack) {
        const songs = await firstValueFrom(this.api.getRecentSongs(200));
        return shuffleArray(songs.map((s) => toTrack(s)));
      }
      const exclude = [
        seed.currentTrack.id,
        ...this.player.queue().map((t) => t.id),
        ...this.player.history().slice(-20).map((t) => t.id),
      ];
      const songs = await firstValueFrom(
        this.api.getRadioNext(seed.currentTrack.id, exclude, 10),
      );
      return songs.map((s) => toTrack(s));
    });
  }

  ngOnDestroy(): void {
    this.transfers.stopPolling();
  }
}
