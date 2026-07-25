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

// Acquisition surfaces (e.g. /downloads) are hidden from listeners; bounce them
// home so a bookmarked/deep-linked URL can't reach the acquisition UI.
export const acquireGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.canAcquire() || router.createUrlTree(['/']);
};
