import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * Native playlists: create → picker → proposals → rename → delete.
 *
 * Replaces the old `playlist-generate.spec.ts` (deleted when
 * generate-from-favorites was removed — see docs/playlist-generation.md).
 * The merged playlists tab lives at `data-testid="playlists-list"` with one
 * `data-testid="playlist-row"` per playlist (curated rows carry
 * `curated-badge-inline` and hide rename/delete — not exercised here since
 * this spec only creates/mutates a user playlist).
 *
 * Proposal coverage needs a genuine token overlap: `FIXTURE.proposalPair`
 * seeds two same-artist tracks sharing a title token ("Nocturne" /
 * "Nocturne Drift"), so adding the first via the song picker makes the
 * second surface under "Suggested for this playlist" via the backend's
 * `matchesAllTokens` scorer (see `PlaylistService.proposals`).
 */
test.describe('playlists', () => {
  test('create, add via picker, see a proposal, rename, and delete', async ({ page }) => {
    const playlistName = `E2E Playlist ${Date.now()}`;
    const renamedName = `${playlistName} (renamed)`;

    // 1. Navigate to the library playlists tab.
    await page.goto('/library');
    await page.getByRole('button', { name: 'Playlists', exact: true }).click();
    await expect(page.getByTestId('playlists-list')).toBeVisible();

    // 2. Create a playlist via the form → redirected to its detail page.
    await page.getByPlaceholder('New playlist name').fill(playlistName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/library\/playlists\/[^/]+$/);
    await expect(page.getByRole('heading', { name: playlistName })).toBeVisible();

    // 3. Song picker: type, get a result, click it, see it land in the tracklist.
    const picker = page.getByTestId('song-picker-input');
    await picker.fill(FIXTURE.proposalPair.seed.title);
    // Both fixture tracks share the "Nocturne" token, so the autocomplete
    // result list contains "Nocturne" AND "Nocturne Drift" — exclude the
    // latter to land on the exact seed track (hasText's regex form is
    // whitespace-sensitive against raw textContent, so anchoring `^Title —`
    // is brittle across the template's own indentation/newlines).
    const seedResult = page
      .getByTestId('song-picker-result')
      .filter({ hasText: FIXTURE.proposalPair.seed.title })
      .filter({ hasNotText: FIXTURE.proposalPair.suggested.title });
    await expect(seedResult).toBeVisible();
    await seedResult.click();
    await expect(page.getByText(FIXTURE.proposalPair.seed.title, { exact: true })).toBeVisible();

    // 4. A proposal surfaces below — the token-overlapping fixture track.
    // (The proposal row renders "{title} — {artist}" as one span with a
    // nested span, so there's no single element whose exact text is just
    // the title — substring match is the right tool here, unlike the
    // track-row assertions above/below where the title is its own <p>.)
    const proposals = page.getByTestId('playlist-proposals');
    await expect(proposals).toBeVisible();
    await expect(proposals.getByText(FIXTURE.proposalPair.suggested.title)).toBeVisible();

    // Add the proposal too, so it also lands in the tracklist.
    await proposals.getByTestId('proposal-add').first().click();
    await expect(
      page.getByText(FIXTURE.proposalPair.suggested.title, { exact: true }),
    ).toBeVisible();

    // 5. Back to the merged list, rename via the inline edit icon.
    await page.goto('/library');
    await page.getByRole('button', { name: 'Playlists', exact: true }).click();
    const row = page.getByTestId('playlist-row').filter({ hasText: playlistName });
    await expect(row).toBeVisible();
    await row.getByTestId('rename-playlist').click();
    // Rename mode swaps the row's `<a>` for an `<input name="renameDraft">`
    // with no text content, so re-filtering `row` by `hasText` after the
    // click matches nothing — locate the input by its ngModel name instead.
    const renameInput = page.locator('input[name="renameDraft"]');
    await renameInput.fill(renamedName);
    await renameInput.press('Enter');
    await expect(page.getByTestId('playlist-row').filter({ hasText: renamedName })).toBeVisible();

    // 6. Delete via the inline trash icon, confirm the dialog, row is gone.
    const renamedRow = page.getByTestId('playlist-row').filter({ hasText: renamedName });
    await renamedRow.getByTestId('delete-playlist').click();
    await expect(page.getByTestId('confirm-ok')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('playlist-row').filter({ hasText: renamedName })).toHaveCount(0);
  });
});
