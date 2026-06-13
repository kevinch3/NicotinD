import { Component, inject, computed, OnInit, OnDestroy } from '@angular/core';
import { APP_VERSION } from '../../app.config';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { PlayerService, shuffleArray } from '../../services/player.service';
import { ApiService } from '../../services/api.service';
import { toTrack } from '../../lib/track-utils';
import { mainBottomPadClass } from '../../lib/player-chrome';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { DownloadIndicatorComponent } from '../download-indicator/download-indicator.component';
import { PlayerComponent } from '../player/player.component';
import { NowPlayingComponent } from '../now-playing/now-playing.component';
import { UpdateBannerComponent } from '../update-banner/update-banner.component';
import { BottomNavComponent } from '../bottom-nav/bottom-nav.component';
import { AddToPlaylistComponent } from '../add-to-playlist/add-to-playlist.component';

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
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    DownloadIndicatorComponent,
    PlayerComponent,
    NowPlayingComponent,
    UpdateBannerComponent,
    BottomNavComponent,
    AddToPlaylistComponent,
  ],
  templateUrl: './layout.component.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  readonly setup = inject(SetupService);
  readonly version = inject(APP_VERSION);
  private transfers = inject(TransferService);
  private acquire = inject(AcquireService);
  private api = inject(ApiService);

  readonly navItems = computed<NavItem[]>(() =>
    this.auth.role() === 'admin' ? [...BASE_NAV, { to: '/admin', label: 'Admin' }] : BASE_NAV,
  );

  isNavDisabled(route: string): boolean {
    return this.setup.isOffline() && ONLINE_ONLY_ROUTES.has(route);
  }

  // Bottom padding so fixed chrome never covers the last list item — geometry
  // shared with the mini-player/tab-bar stack in lib/player-chrome.ts.
  readonly mainPadClass = computed(() => mainBottomPadClass(this.player.currentTrack() !== null));

  ngOnInit(): void {
    this.transfers.startPolling();
    // Load any in-flight URL acquisitions so the header badge reflects them
    // app-wide (AcquireService self-polls while jobs are active).
    void this.acquire.refresh();

    // Radio source: a shuffled pool of library tracks so playback never stops.
    // Registered here (not in PlayerService) so the service stays HTTP-free.
    this.player.setRadioProvider(async () => {
      const songs = await firstValueFrom(this.api.getRecentSongs(200));
      return shuffleArray(songs.map((s) => toTrack(s)));
    });
  }

  ngOnDestroy(): void {
    this.transfers.stopPolling();
  }

  logout(): void {
    this.auth.logout();
    window.location.assign('/login');
  }
}
