import { Routes } from '@angular/router';
import { authGuard, adminGuard, acquireGuard, serverGuard } from './guards/auth.guard';

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
        path: 'search',
        loadComponent: () =>
          import('./pages/search/search.component').then((m) => m.SearchComponent),
      },
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
        path: 'settings/plugins',
        loadComponent: () =>
          import('./pages/plugins/plugins.component').then((m) => m.PluginsComponent),
        canActivate: [adminGuard],
      },
      {
        path: 'settings/plugins/slskd',
        loadComponent: () =>
          import('./pages/plugins/slskd/slskd-settings.component').then(
            (m) => m.SlskdSettingsComponent,
          ),
        canActivate: [adminGuard],
      },
      {
        path: 'admin',
        loadComponent: () => import('./pages/admin/admin.component').then((m) => m.AdminComponent),
        canActivate: [adminGuard],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
