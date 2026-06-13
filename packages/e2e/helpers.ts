import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

/** Admin seeded by auth.setup.ts (first user => admin). */
export const ADMIN = { username: 'e2e-admin', password: 'e2e-password-123' } as const;

/** Where the setup project saves the authenticated storageState. */
export const AUTH_FILE = '.auth/admin.json';

/**
 * Mirrors fixtures/music — see scripts/make-fixtures.ts. The 7-track album is
 * classified `album` and shows in the Albums grid; the loose single surfaces on
 * the artist page / singles list.
 */
export const FIXTURE = {
  album: { artist: 'E2E Test Artist', title: 'E2E Test Album', trackCount: 7 },
  single: { artist: 'E2E Single Artist', title: 'E2E Lonesome Single' },
} as const;

/** auth header for direct API calls in setup/teardown. */
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Wait until the library scan has settled and at least one album is listed. */
export async function waitForLibrary(request: APIRequestContext, token: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get('/api/library/albums', { headers: bearer(token) });
        if (!r.ok()) return 0;
        const albums = (await r.json()) as unknown[];
        return Array.isArray(albums) ? albums.length : 0;
      },
      { timeout: 30_000, intervals: [500, 1000, 1500] },
    )
    .toBeGreaterThan(0);
}
