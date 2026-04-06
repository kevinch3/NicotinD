import { Component, inject, signal, computed, effect } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { DownloadIndicatorComponent } from '../download-indicator/download-indicator.component';
import { PlayerComponent } from '../player/player.component';
import { NowPlayingComponent } from '../now-playing/now-playing.component';

interface NavItem {
  to: string;
  label: string;
}

const BASE_NAV: NavItem[] = [
  { to: '/', label: 'Search' },
  { to: '/downloads', label: 'Downloads' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/library', label: 'Library' },
  { to: '/settings', label: 'Settings' },
];

@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DownloadIndicatorComponent, PlayerComponent, NowPlayingComponent],
  templateUrl: './layout.component.html',
  })
export class LayoutComponent {
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private router = inject(Router);

  readonly drawerOpen = signal(false);
  readonly navItems = computed<NavItem[]>(() =>
    this.auth.role() === 'admin'
      ? [...BASE_NAV, { to: '/admin', label: 'Admin' }]
      : BASE_NAV,
  );

  constructor() {
    // Close drawer on navigation
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.drawerOpen.set(false));
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
