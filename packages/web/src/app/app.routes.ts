import { Routes } from '@angular/router';
import { authGuard, adminGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
  { path: 'setup', loadComponent: () => import('./pages/setup/setup.component').then(m => m.SetupComponent) },
  {
    path: '',
    loadComponent: () => import('./components/layout/layout.component').then(m => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      { path: '', loadComponent: () => import('./pages/search/search.component').then(m => m.SearchComponent) },
      { path: 'downloads', loadComponent: () => import('./pages/downloads/downloads.component').then(m => m.DownloadsComponent) },
      { path: 'playlists', loadComponent: () => import('./pages/playlists/playlists.component').then(m => m.PlaylistsComponent) },
      { path: 'library', loadComponent: () => import('./pages/library/library.component').then(m => m.LibraryComponent) },
      { path: 'library/albums/:id', loadComponent: () => import('./pages/library/album-detail.component').then(m => m.AlbumDetailComponent) },
      { path: 'library/artists/:id', loadComponent: () => import('./pages/library/artist-detail.component').then(m => m.ArtistDetailComponent) },
      { path: 'library/genres/:slug', loadComponent: () => import('./pages/library/genre-detail.component').then(m => m.GenreDetailComponent) },
      { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then(m => m.SettingsComponent) },
      { path: 'admin', loadComponent: () => import('./pages/admin/admin.component').then(m => m.AdminComponent), canActivate: [adminGuard] },
    ],
  },
  { path: '**', redirectTo: '' },
];
