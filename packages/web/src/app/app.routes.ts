import { Routes } from '@angular/router';
import {
  authGuard,
  adminGuard,
  acquireGuard,
  curatorGuard,
  serverGuard,
} from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'server',
    loadComponent: () =>
      import('./pages/server-config/server-config.component').then((m) => m.ServerConfigComponent),
  },
  {
    path: 'login',
    canActivate: [serverGuard],
    loadComponent: () => import('./pages/login/login.component').then((m) => m.LoginComponent),
  },
  {
    // Public pairing landing page — the QR's `/pair#t=…` link opens here when
    // scanned with a plain camera app; claims the token and signs the browser in.
    path: 'pair',
    loadComponent: () => import('./pages/pair/pair.component').then((m) => m.PairComponent),
  },
  {
    // Phone-side approval for a TV's sign-in code — the TV's QR encodes
    // `/approve#c=…` (code in the fragment, like /pair). Auth-guarded: an
    // unauthenticated scan round-trips through login and returns here with
    // the fragment intact (sanitizeReturnUrl keeps in-app paths).
    path: 'approve',
    canActivate: [serverGuard, authGuard],
    loadComponent: () =>
      import('./pages/approve-login/approve-login.component').then((m) => m.ApproveLoginComponent),
  },
  {
    path: 'setup',
    loadComponent: () => import('./pages/setup/setup.component').then((m) => m.SetupComponent),
  },
  {
    path: 'share/:token',
    loadComponent: () =>
      import('./pages/share/share-view.component').then((m) => m.ShareViewComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./components/layout/layout.component').then((m) => m.LayoutComponent),
    canActivate: [serverGuard, authGuard],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./pages/radio-landing/radio-landing.component').then(
            (m) => m.RadioLandingComponent,
          ),
      },
      {
        // Renamed from 'search' to 'acquire' (issue #227): the page is
        // acquisition-only ("get new music"), while "find what I own" lives in
        // Library/Radio. The component keeps its SearchComponent name — the
        // backend is still /api/search — but the user-facing route + nav read
        // "Acquire".
        path: 'acquire',
        loadComponent: () =>
          import('./pages/search/search.component').then((m) => m.SearchComponent),
      },
      // Preserve every existing /search link, bookmark, and e2e goto — the
      // redirect carries query params (e.g. ?q=…) through by default.
      { path: 'search', redirectTo: 'acquire', pathMatch: 'full' },
      {
        path: 'downloads',
        canActivate: [acquireGuard],
        loadComponent: () =>
          import('./pages/downloads/downloads.component').then((m) => m.DownloadsComponent),
      },
      {
        path: 'library',
        loadComponent: () =>
          import('./pages/library/library.component').then((m) => m.LibraryComponent),
      },
      {
        path: 'library/albums/:id',
        loadComponent: () =>
          import('./pages/library/album-detail.component').then((m) => m.AlbumDetailComponent),
      },
      {
        path: 'library/artists/:id',
        loadComponent: () =>
          import('./pages/library/artist-detail.component').then((m) => m.ArtistDetailComponent),
      },
      {
        path: 'library/genres/:slug',
        loadComponent: () =>
          import('./pages/library/genre-detail.component').then((m) => m.GenreDetailComponent),
      },
      {
        path: 'library/playlists/:id',
        loadComponent: () =>
          import('./pages/library/playlist-detail.component').then(
            (m) => m.PlaylistDetailComponent,
          ),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/settings/settings.component').then((m) => m.SettingsComponent),
      },
      {
        path: 'settings/devices',
        loadComponent: () =>
          import('./pages/settings/devices/devices.component').then((m) => m.DevicesComponent),
      },
      {
        path: 'settings/agent-tokens',
        loadComponent: () =>
          import('./pages/settings/agent-tokens/agent-tokens.component').then(
            (m) => m.AgentTokensComponent,
          ),
        canActivate: [curatorGuard],
      },
      {
        path: 'settings/plugins',
        loadComponent: () =>
          import('./pages/plugins/plugins.component').then((m) => m.PluginsComponent),
        canActivate: [adminGuard],
      },
      // Task 4 (settings-cards unification): slskd no longer has its own page —
      // its settings are embedded inline in its Extensions card body (see
      // PluginCardComponent's docstring). Redirect any existing bookmark/link,
      // mirroring the house shape used by the search → acquire redirect above
      // (relative target + explicit pathMatch: 'full').
      { path: 'settings/plugins/slskd', redirectTo: 'settings/plugins', pathMatch: 'full' },
      {
        path: 'admin',
        loadComponent: () => import('./pages/admin/admin.component').then((m) => m.AdminComponent),
        canActivate: [adminGuard],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
