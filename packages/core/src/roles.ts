/**
 * User role ladder — the single source of truth shared by the API guards and the
 * web UI gating. Roles form a strict ascending capability ladder: each tier is a
 * superset of the one below it.
 *
 *   listener < user < refiner < admin
 *
 * - listener: play/search the library, own playlists, cast — but NO acquisition
 *   surfaces (declutter for casual users). Admin-assigned; enforced server-side.
 * - user:     everything listener can + acquire (hunt/download/URL, Downloads).
 * - refiner:  everything user can + curate the library (edit/merge/delete albums,
 *             metadata/cover/artist-image overrides, artist-identity, genre, lyrics).
 * - admin:    everything + server administration (user mgmt, settings, /sync, …).
 */
export type Role = 'listener' | 'user' | 'refiner' | 'admin';

/** Ascending capability rank; higher = more power. */
const RANK: Record<Role, number> = { listener: 0, user: 1, refiner: 2, admin: 3 };

/** Coerce an unknown/legacy role string to a valid Role, defaulting to 'user'
 * (the historical default) so a missing/garbage value never grants elevated power. */
export function asRole(role: string | undefined | null): Role {
  return role != null && role in RANK ? (role as Role) : 'user';
}

/** May use acquisition surfaces (hunt/download/URL, Downloads feed, network search). */
export const canAcquire = (role: Role): boolean => RANK[role] >= RANK.user;

/** May curate the library (destructive/edit actions). */
export const canCurate = (role: Role): boolean => RANK[role] >= RANK.refiner;

/** Full server administrator. */
export const isAdmin = (role: Role): boolean => role === 'admin';

/** All valid roles, low → high — handy for admin role <select> options + Zod enums. */
export const ROLES: readonly Role[] = ['listener', 'user', 'refiner', 'admin'];
