import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { provideRouter, Router, UrlTree } from '@angular/router';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';
import { ServerConfigService } from '../services/server-config.service';

/**
 * Issue #231: the auth guard must stash the attempted URL as `returnUrl` when it
 * bounces an unauthenticated user to /login, so login can send them back.
 */
describe('authGuard (returnUrl capture)', () => {
  let authenticated = false;

  beforeEach(() => {
    authenticated = false;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { isAuthenticated: () => authenticated } },
        { provide: ServerConfigService, useValue: { needsConfiguration: () => false } },
      ],
    });
  });

  function run(url: string): boolean | UrlTree {
    const state = { url } as RouterStateSnapshot;
    return TestBed.runInInjectionContext(() =>
      authGuard({} as ActivatedRouteSnapshot, state),
    ) as boolean | UrlTree;
  }

  it('passes through when authenticated', () => {
    authenticated = true;
    expect(run('/library/artists/x')).toBe(true);
  });

  it('redirects to /login carrying the attempted URL as returnUrl', () => {
    const result = run('/library/artists/abc?tab=songs');
    expect(result).toBeInstanceOf(UrlTree);
    const router = TestBed.inject(Router);
    const serialized = router.serializeUrl(result as UrlTree);
    expect(serialized).toContain('/login');
    // The whole attempted URL is preserved (url-encoded) in the query param.
    expect(serialized).toContain('returnUrl=');
    expect(decodeURIComponent(serialized)).toContain('/library/artists/abc?tab=songs');
  });
});
