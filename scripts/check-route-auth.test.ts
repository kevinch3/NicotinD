import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PUBLIC_ROUTES,
  auditRouteAuth,
  authedPrefixes,
  isCovered,
  mountedRoutes,
} from './check-route-auth.js';

const ROOT = resolve(import.meta.dir, '..');

const SOURCE = `
  app.use('/api/library/*', auth);
  app.use('/api/admin/*', auth);
  app.route('/api/library', libraryRoutes());
  app.route('/api/admin/remote-access', remoteAccessRoutes());
  app.route('/api/health', healthRoutes(version));
  app.route('/api/radio', radioRoutes());
`;

describe('mountedRoutes / authedPrefixes', () => {
  it('finds every mounted group', () => {
    expect(mountedRoutes(SOURCE)).toEqual([
      '/api/admin/remote-access',
      '/api/health',
      '/api/library',
      '/api/radio',
    ]);
  });

  it('finds the auth-protected prefixes', () => {
    expect(authedPrefixes(SOURCE)).toEqual(['/api/admin', '/api/library']);
  });

  it('ignores a use() that applies something other than auth', () => {
    expect(authedPrefixes("app.use('/api/*', nativeAppCors());")).toEqual([]);
  });
});

describe('isCovered', () => {
  it('treats a parent prefix as coverage', () => {
    // app.use('/api/admin/*', auth) protects /api/admin/remote-access.
    expect(isCovered('/api/admin/remote-access', ['/api/admin'])).toBe(true);
  });

  it('does not treat a string prefix as a path prefix', () => {
    // /api/radiofoo must not be considered covered by /api/radio.
    expect(isCovered('/api/radiofoo', ['/api/radio'])).toBe(false);
  });

  it('matches an exact prefix', () => {
    expect(isCovered('/api/library', ['/api/library'])).toBe(true);
  });
});

describe('auditRouteAuth', () => {
  it('flags a group mounted without auth', () => {
    // The exact #461 shape: mounted, never added to the auth list.
    expect(auditRouteAuth(SOURCE).unprotected).toEqual(['/api/radio']);
  });

  it('does not flag a deliberately public route', () => {
    expect(auditRouteAuth(SOURCE).unprotected).not.toContain('/api/health');
  });

  it('every PUBLIC_ROUTES entry carries a reason', () => {
    // An allowlist without reasons decays into a dumping ground.
    for (const p of PUBLIC_ROUTES) expect(p.reason.length).toBeGreaterThan(10);
  });
});

describe('the real index.ts', () => {
  it('has no /api route group mounted without auth or an explicit exemption', () => {
    const source = readFileSync(resolve(ROOT, 'packages/api/src/index.ts'), 'utf8');
    expect(auditRouteAuth(source).unprotected).toEqual([]);
  });

  it('actually finds routes — a restructure must not silently pass the gate', () => {
    const source = readFileSync(resolve(ROOT, 'packages/api/src/index.ts'), 'utf8');
    expect(auditRouteAuth(source).mounted.length).toBeGreaterThan(10);
  });

  it('protects radio and catalog (issue #461)', () => {
    const source = readFileSync(resolve(ROOT, 'packages/api/src/index.ts'), 'utf8');
    const authed = authedPrefixes(source);
    expect(isCovered('/api/radio', authed)).toBe(true);
    expect(isCovered('/api/catalog', authed)).toBe(true);
  });
});
