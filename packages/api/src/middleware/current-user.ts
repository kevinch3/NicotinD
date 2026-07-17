import type { Context } from 'hono';
import { ForbiddenError, asRole, canAcquire, canCurate, type JwtPayload } from '@nicotind/core';
import type { AuthEnv } from './auth.js';

/** The authenticated user attached by `authMiddleware`. Every route runs behind
 * it, so `user` is always present — this is just the typed, one-call accessor
 * that replaces ~40 inline `c.get('user')` derivations across the routes. */
export function getCurrentUser(c: Context<AuthEnv>): JwtPayload {
  return c.get('user');
}

/** Return the current user, or throw a 403 `ForbiddenError` (mapped to
 * `{ error, code }` by the central error handler) when they aren't an admin.
 * Collapses the repeated `const user = c.get('user'); if (user.role !== 'admin')
 * return c.json({ error: 'Admin only' }, 403);` guard into one call that also
 * hands back the user for downstream use. */
export function requireAdmin(c: Context<AuthEnv>): JwtPayload {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  return user;
}

/** Return the current user, or throw a 403 unless they can curate the library
 * (refiner or admin). Backs the library edit/merge/delete/metadata routes. */
export function requireCurator(c: Context<AuthEnv>): JwtPayload {
  const user = c.get('user');
  if (!canCurate(asRole(user.role))) throw new ForbiddenError('Requires curator role');
  return user;
}

/** Return the current user, or throw a 403 unless they can acquire (anyone but a
 * listener). Backs the acquisition route groups (hunt/download/URL/Downloads). */
export function requireAcquirer(c: Context<AuthEnv>): JwtPayload {
  const user = c.get('user');
  if (!canAcquire(asRole(user.role))) throw new ForbiddenError('Requires acquisition access');
  return user;
}
