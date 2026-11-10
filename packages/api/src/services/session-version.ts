/**
 * Session versions (docs/email-invitations.md "Engineering rules"): JWTs are
 * stateless, so "sign out everywhere" needs one piece of state — the
 * `users.token_version` a token was minted at, carried as its `tv` claim and
 * compared on every request by `authMiddleware`.
 *
 * Every mint site reads the current value through `sessionVersionOf`, so a token
 * minted after a bump is valid and every one minted before it is not.
 */
import type { Database } from 'bun:sqlite';

export function sessionVersionOf(db: Database, userId: string): number {
  return (
    db
      .query<{ v: number }, [string]>(
        'SELECT COALESCE(token_version, 0) AS v FROM users WHERE id = ?',
      )
      .get(userId)?.v ?? 0
  );
}

/** Invalidate every existing session of the user; returns the new version. */
export function bumpSessionVersion(db: Database, userId: string): number {
  db.run('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?', [userId]);
  return sessionVersionOf(db, userId);
}

/**
 * Whether a verified token still belongs to a live session. Share tokens are
 * exempt: their `sub` is the *creator* of a public link, and a password change
 * by the owner is not a reason to break a link they handed out.
 */
export function sessionVersionMatches(
  claims: { tv?: number; share?: boolean },
  current: number,
): boolean {
  if (claims.share === true) return true;
  return (claims.tv ?? 0) === current;
}
