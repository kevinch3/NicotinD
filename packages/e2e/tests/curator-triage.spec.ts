/**
 * Curator triage (docs/curator-triage.md "Closed options only") — DOM coverage
 * for the round the library's "decisions waiting" card links into.
 *
 * The round serves only cases with a one-sentence question and closed options
 * that do something, so the spec seeds two TYPED flags through the real
 * curator endpoint (the same parser the MCP tool uses). The effects are never
 * fired: the spec skips one card, cancels a destructive option on the other,
 * then picks its labelled "keep" choice, which closes the flag with no data
 * change — fixture state shared with every other spec stays untouched.
 */
import { test, expect, type APIRequestContext } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

const RESEARCH = 'e2e research: the credit line names two acts, neither fingerprinted.';

test.describe('curator triage', () => {
  test('a curator works a round of closed-option cases from the library view', async ({
    page,
    request,
  }) => {
    const jwt = await token(request);

    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const first = artists.find((a) => a.name === FIXTURE.album.artist)!;
    const second = artists.find((a) => a.name === FIXTURE.single.artist)!;
    expect(first, 'fixture album artist must exist').toBeTruthy();
    expect(second, 'fixture single artist must exist').toBeTruthy();

    const file = (artist: { id: string; name: string }, question: string) =>
      request.post('/api/library/review-flags', {
        headers: bearer(jwt),
        data: {
          targetKind: 'artist',
          targetId: artist.id,
          reason: RESEARCH,
          question,
          caseKind: 'identity',
          options: [
            {
              id: 'merge',
              label: 'Credit the first act',
              rationale: 'the set is theirs',
              effect: { type: 'artist-merge', rawName: artist.name, mergeInto: artist.name },
            },
            {
              id: 'del',
              label: 'Delete the stray file',
              effect: { type: 'song-delete', songId: 'e2e-no-such-song' },
            },
            {
              id: 'keep',
              label: 'Keep both credits',
              rationale: 'two real acts',
              effect: { type: 'resolve-only' },
            },
          ],
        },
      });
    expect((await file(first, 'e2e: who gets the credit on the first?')).ok()).toBe(true);
    expect((await file(second, 'e2e: who gets the credit on the second?')).ok()).toBe(true);

    await page.goto('/library');
    const entry = page.getByTestId('curate-entry');
    await expect(entry).toBeVisible();
    await entry.click();

    await expect(page).toHaveURL(/\/library\/curate$/);
    const card = page.getByTestId('case-card');
    await expect(card).toBeVisible();
    // Only typed cases are served, so the round is exactly the two we filed —
    // a prose flag another spec leaves open (report-track.spec.ts) is not a card.
    await expect(page.getByTestId('curate-progress')).toHaveText(/1 \/ 2/);

    // The question is the card; the research is folded behind it.
    await expect(page.getByTestId('case-question')).toContainText('who gets the credit');
    await expect(page.getByTestId('case-details-text')).toBeHidden();
    await page.getByTestId('case-details').locator('summary').click();
    await expect(page.getByTestId('case-details-text')).toContainText(RESEARCH);

    // Skip is a server-side deferral: this card must not come back below.
    await page.getByTestId('case-skip').click();
    await expect(page.getByTestId('curate-progress')).toHaveText(/2 \/ 2/);

    // A destructive option asks once more, and cancelling fires nothing.
    await page.getByTestId('case-option').filter({ hasText: 'Delete the stray file' }).click();
    await expect(page.getByTestId('case-confirm')).toBeVisible();
    await page.getByTestId('case-confirm-no').click();
    await expect(page.getByTestId('case-confirm')).toBeHidden();

    // The agent's own "keep" choice closes the case with no data change.
    await page.getByTestId('case-option').filter({ hasText: 'Keep both credits' }).click();
    await expect(page.getByTestId('curate-done')).toBeVisible();

    // A fresh load: the applied case is gone and the skipped one is deferred,
    // so there is nothing to serve — and the library card no longer advertises.
    await page.goto('/library/curate');
    await expect(page.getByTestId('curate-done')).toBeVisible();
    await expect(page.getByTestId('curate-progress')).toHaveCount(0);
    await page.goto('/library');
    await expect(page.getByTestId('curate-entry')).toHaveCount(0);
  });
});
