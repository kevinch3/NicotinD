import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /**
   * Same-artist pair sharing a title token ("Nocturne" / "Nocturne Drift") —
   * exists so playlist-proposals e2e coverage has a genuine token overlap:
   * adding the first seeds proposal tokens that are all substrings of the
   * second's title+artist (see `PlaylistService.proposals`).
   */
  proposalPair: {
    artist: 'E2E Playlist Seed Artist',
    seed: { title: 'Nocturne' },
    suggested: { title: 'Nocturne Drift' },
  },
} as const;

/** auth header for direct API calls in setup/teardown. */
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const MUSIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/music');

/**
 * Snapshot a music fixture and put it back once the calling spec file finishes.
 *
 * **Any spec that deletes a fixture from disk must call this.** The fixtures under
 * `fixtures/music` are **git-tracked**, and `scripts/make-fixtures.ts` needs ffmpeg —
 * which CI does not have — so they are generated once and committed, never
 * regenerated per run (`bun run e2e` is a bare `playwright test`). A spec that
 * deletes one therefore leaves the working tree one file short *permanently*: it
 * passes exactly once per `git checkout`, and every later run fails on a fixture
 * that is simply gone. Restoring here keeps runs repeatable and the tree clean.
 *
 * Registers its own `beforeAll`/`afterAll`, so just call it at describe scope.
 *
 * @param relPath path under `fixtures/music`, e.g. `'E2E_Test_Artist/E2E_Test_Album/04 - Quiet_Hours.flac'`
 */
export function preserveMusicFixture(relPath: string): void {
  const abs = join(MUSIC_ROOT, relPath);
  let snapshot: Buffer | null = null;

  test.beforeAll(() => {
    if (existsSync(abs)) snapshot = readFileSync(abs);
  });

  test.afterAll(() => {
    // Only rewrite when the spec actually removed it — never clobber a live file.
    if (snapshot && !existsSync(abs)) writeFileSync(abs, snapshot);
  });
}

/**
 * Expand a collapsible `<app-settings-group>` card (Admin + Settings pages —
 * see docs/web-ui.md) identified by its `groupId`, no-op if already open.
 * Every group renders collapsed by default and persists open/closed state to
 * localStorage per device, so a spec that needs to interact with a card's body
 * must expand it first.
 */
export async function expandGroup(page: Page, groupId: string): Promise<void> {
  const toggle = page.locator(`[data-group-id="${groupId}"]`).getByTestId('settings-group-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

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
