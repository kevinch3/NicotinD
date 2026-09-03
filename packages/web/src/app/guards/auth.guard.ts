import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ServerConfigService } from '../services/server-config.service';

// Native shell only: before anything else, force the server-picker when no server
// has been chosen yet. Always passes on web (needsConfiguration() is false there),
// so the web build never sees the picker.
export const serverGuard: CanActivateFn = () => {
  const server = inject(ServerConfigService);
  const router = inject(Router);
  return !server.needsConfiguration() || router.createUrlTree(['/server']);
};

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  // Issue #231: preserve the attempted URL so login can send the user back to
  // the page they were deep-linked to (a shared artist/album/playlist link,
  // a bookmark) instead of dumping them on the home route. Login sanitizes it.
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAdmin() || router.createUrlTree(['/']);
};

// Library curation surfaces (e.g. minting an MCP agent token, issue #232) are
// refiner+ — mirrors the server's requireCurator gate on the same routes.
export const curatorGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.canCurate() || router.createUrlTree(['/']);
};

// Acquisition surfaces (e.g. /downloads) are hidden from listeners; bounce them
// home so a bookmarked/deep-linked URL can't reach the acquisition UI.
//
// `canImport` is the second arm rather than a second guard: /get hosts both the
// acquire lanes AND the import drop zone, and import outlives the acquisition
// kill-switch. Guarding on `canAcquire` alone would bounce a user away from the
// one lane still available to them on a streaming-only install. The lanes inside
// the page gate themselves individually.
export const acquireGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.canAcquire() || auth.canImport() || router.createUrlTree(['/']);
};
