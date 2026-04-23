import { Component, inject, signal, computed, effect } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { SearchService } from '../../services/search.service';
import { SetupService } from '../../services/setup.service';
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
// Nav items that require the backend to be available
const ONLINE_ONLY_ROUTES = new Set(['/', '/library', '/playlists']);

@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, DownloadIndicatorComponent, PlayerComponent, NowPlayingComponent],
  templateUrl: './layout.component.html',
})

export class LayoutComponent {
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  readonly search = inject(SearchService);
  readonly setup = inject(SetupService);
  private router = inject(Router);

  readonly drawerOpen = signal(false);
  readonly navItems = computed<NavItem[]>(() =>
    this.auth.role() === 'admin'
      ? [...BASE_NAV, { to: '/admin', label: 'Admin' }]
      : BASE_NAV,
  );

  isNavDisabled(route: string): boolean {
    return this.setup.isOffline() && ONLINE_ONLY_ROUTES.has(route);
  }

  constructor() {
    // Close drawer on navigation
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.drawerOpen.set(false));
  }

  submitSearch(event: Event): void {
    event.preventDefault();
    const q = this.search.query().trim();
    if (!q) return;
    this.search.setAutoSearch(true);
    this.router.navigate(['/']);
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
