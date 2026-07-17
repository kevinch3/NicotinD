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
import { ConfirmHostComponent } from '../confirm-host/confirm-host.component';
import { TrackInfoHostComponent } from '../track-info-host/track-info-host.component';
import { ChangelogModalComponent } from '../changelog-modal/changelog-modal.component';

interface NavItem {
  to: string;
  label: string;
}

const BASE_NAV: NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/search', label: 'Search' },
  { to: '/downloads', label: 'Downloads' },
  { to: '/library', label: 'Library' },
  { to: '/settings', label: 'Settings' },
];
// Nav items that require the backend to be available. Library stays enabled
// offline: its Songs tab serves the on-device downloaded songs. The radio
// landing (/) and search need the backend, so both are online-only.
const ONLINE_ONLY_ROUTES = new Set(['/', '/search']);

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
    ConfirmHostComponent,
    ChangelogModalComponent,
    TrackInfoHostComponent,
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

  readonly navItems = computed<NavItem[]>(() => {
    // Downloads is an acquisition surface — hidden from listeners (declutter).
    const base = this.auth.canAcquire()
      ? BASE_NAV
      : BASE_NAV.filter((n) => n.to !== '/downloads');
    return this.auth.isAdmin() ? [...base, { to: '/admin', label: 'Admin' }] : base;
  });

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
      const exclude = [
        seed.currentTrack?.id,
        ...this.player.queue().map((t) => t.id),
        ...this.player.history().slice(-20).map((t) => t.id),
      ].filter((id): id is string => !!id);

      // Filter "vibe" radio: keep pulling in-filter tracks so the mood holds.
      const filter = this.player.radioFilter();
      if (filter) {
        const songs = await firstValueFrom(this.api.getFilterRadio(filter, exclude, 10));
        if (songs.length) return songs.map((s) => toTrack(s));
        // Filter exhausted → fall through to seed/shuffle so playback continues.
      }

      if (!seed.currentTrack) {
        const songs = await firstValueFrom(this.api.getAllSongs(200, 0, { sort: 'newest' }));
        return shuffleArray(songs.map((s) => toTrack(s)));
      }
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
