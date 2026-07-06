import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { ForbiddenError, type JwtPayload } from '@nicotind/core';
import { getCurrentUser, requireAdmin } from './current-user.js';
import type { AuthEnv } from './auth.js';

function ctx(user: Partial<JwtPayload>): Context<AuthEnv> {
  return { get: (k: string) => (k === 'user' ? user : undefined) } as unknown as Context<AuthEnv>;
}

const admin: JwtPayload = { sub: 'a', role: 'admin', iat: 0, exp: 9 };
const member: JwtPayload = { sub: 'u', role: 'user', iat: 0, exp: 9 };

describe('getCurrentUser', () => {
  it('returns the authenticated user from context', () => {
    expect(getCurrentUser(ctx(member))).toEqual(member);
  });
});

describe('requireAdmin', () => {
  it('returns the user when they are an admin', () => {
    expect(requireAdmin(ctx(admin))).toEqual(admin);
  });

  it('throws a 403 ForbiddenError for a non-admin', () => {
    expect(() => requireAdmin(ctx(member))).toThrow(ForbiddenError);
    try {
      requireAdmin(ctx(member));
    } catch (e) {
      expect((e as ForbiddenError).statusCode).toBe(403);
      expect((e as ForbiddenError).message).toBe('Admin only');
    }
  });
});
