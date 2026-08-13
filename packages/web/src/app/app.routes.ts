import { inject } from '@angular/core';
import { RedirectFunction, Router, Routes } from '@angular/router';
import { isTvBuild } from './lib/platform';
import {
  authGuard,
  adminGuard,
  acquireGuard,
  curatorGuard,
  serverGuard,
} from './guards/auth.guard';
import type { GetTab } from './pages/get/get.component';

/** Redirect a legacy acquisition path onto the merged /get route's tab, keeping
 *  whatever query params came in (a bookmarked /search?q=… still arrives with
 *  its query). A `RedirectFunction` runs in an injection context, so it can
 *  build the UrlTree itself — which a string `redirectTo` cannot do, because
 *  that form can only *preserve* params, never add the `tab` one. */
function redirectToGetTab(tab: GetTab): RedirectFunction {
  return ({ queryParams }) =>
    inject(Router).createUrlTree(['/get'], { queryParams: { ...queryParams, tab } });
}

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
  // The authenticated shell. TV gets its OWN tree (docs/tv-ux.md): a route that
  // does not exist cannot be reached by a stray routerLink and cannot accumulate
  // a focus trap nobody is watching, which is why the TV surface subtracts
  // routes rather than hiding them with CSS.
  //
  // `isTvBuild()` (environment-baked), NOT `isTvUi()` (reads the `tv-build`
  // root class). This module's body is evaluated when main.ts imports
  // appConfig — and ES imports are hoisted, so that happens BEFORE main.ts
  // calls `applyTvBuildClass()`. A DOM-based check here is always false and the
  // TV tree silently never registers. Anything picking a route tree at module
  // scope must use the build-time signal.
  ...(isTvBuild() ? [tvShellRoute()] : []),
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
        // The merged acquisition workspace. "Acquire" (find new music) and
        // "Downloads" (watch it arrive) are two halves of one job, so they're
        // one route with an internal `?tab=` rather than two nav destinations.
        // The whole route is acquireGuard'ed — previously only /downloads was,
        // while /acquire soft-gated itself with an in-template empty state.
        path: 'get',
        canActivate: [acquireGuard],
        loadComponent: () => import('./pages/get/get.component').then((m) => m.GetComponent),
      },
      // Preserve every existing /search, /acquire and /downloads link, bookmark
      // and e2e goto. A function redirect is required (not a string) because
      // the target needs a `tab` param *added* while the incoming ones — e.g.
      // ?q=… — are carried through; a string redirectTo can only preserve.
      { path: 'search', pathMatch: 'full', redirectTo: redirectToGetTab('find') },
      { path: 'acquire', pathMatch: 'full', redirectTo: redirectToGetTab('find') },
      { path: 'downloads', pathMatch: 'full', redirectTo: redirectToGetTab('downloads') },
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
        path: 'settings/privacy',
        loadComponent: () =>
          import('./pages/settings/privacy/privacy.component').then(
            (m) => m.PrivacySettingsComponent,
          ),
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
      {
        path: 'admin',
        loadComponent: () => import('./pages/admin/admin.component').then((m) => m.AdminComponent),
        canActivate: [adminGuard],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

/**
 * The TV route tree — five screens and nothing else. Acquire, Downloads, Admin,
 * artist/genre/playlist detail and the settings sub-pages are all absent by
 * construction: each is search- or form-driven, and a remote has no Tab to
 * escape a native control with (issue #438).
 */
function tvShellRoute() {
  return {
    path: '',
    loadComponent: () =>
      import('./components/tv-shell/tv-shell.component').then((m) => m.TvShellComponent),
    canActivate: [serverGuard, authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./pages/tv/tv-home.component').then((m) => m.TvHomeComponent),
      },
      {
        path: 'library',
        loadComponent: () =>
          import('./pages/tv/tv-browse.component').then((m) => m.TvBrowseComponent),
      },
      {
        path: 'library/albums/:id',
        loadComponent: () =>
          import('./pages/tv/tv-album.component').then((m) => m.TvAlbumComponent),
      },
      {
        path: 'player',
        loadComponent: () =>
          import('./pages/tv/tv-player.component').then((m) => m.TvPlayerComponent),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/tv/tv-settings.component').then((m) => m.TvSettingsComponent),
      },
    ],
  };
}
