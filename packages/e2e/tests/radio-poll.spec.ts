import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * Radio evaluation polls (docs/radio-eval-polls.md): an admin freezes radio
 * scenarios behind a public link; an ANONYMOUS visitor walks the wizard and
 * votes. The anonymous half runs in a fresh browser context with no storage
 * state — the page must render without ever bouncing through /login (the auth
 * interceptor redirects on any 401, so this asserts the public endpoints
 * genuinely never 401).
 */
test.describe('radio evaluation polls', () => {
  async function createPoll(
    request: APIRequestContext,
  ): Promise<{ id: string; token: string; url: string; adminToken: string }> {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const adminToken = ((await login.json()) as { token: string }).token;
    const created = await request.post('/api/admin/radio-polls', {
      headers: bearer(adminToken),
      // Small counts: the e2e fixture library is tiny, so ask for little and
      // assert ≥ 1 below rather than exact K.
      data: { name: 'E2E poll', scenarioCount: 2, nextUpCount: 2 },
    });
    expect(created.status(), 'poll creation should succeed').toBe(201);
    const body = (await created.json()) as { id: string; token: string; url: string };
    expect(body.url).toContain(`/poll/${body.token}`);
    return { ...body, adminToken };
  }

  /** Thumb every candidate in the visible scenario, then advance — waiting for
   *  the step to actually change (the advance POSTs first), so the loop can't
   *  re-vote a scenario that is still submitting. */
  async function rateScenario(page: Page): Promise<void> {
    await expect(page.getByTestId('poll-scenario')).toBeVisible();
    const progress = await page.getByTestId('poll-progress').innerText();
    const rows = page.getByTestId('poll-candidate-row');
    const count = await rows.count();
    expect(count, 'a scenario should have at least one candidate').toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      const btn = rows.nth(i).getByTestId(i % 2 === 0 ? 'poll-vote-up' : 'poll-vote-down');
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
    }
    await page.getByTestId('poll-next').click();
    // Done screen, or the next scenario's progress label — never the same step.
    await expect(
      page
        .getByTestId('poll-done')
        .or(page.getByTestId('poll-progress').filter({ hasNotText: progress })),
    ).toBeVisible();
  }

  test('anonymous visitor walks the wizard, votes, and the admin sees tallies', async ({
    request,
    browser,
    baseURL,
  }) => {
    const { id, token, adminToken } = await createPoll(request);

    // Fresh context = no stored session: a genuinely anonymous rater.
    const ctx = await browser.newContext({ baseURL: baseURL ?? undefined });
    const page = await ctx.newPage();
    await page.goto(`/poll/${token}`);

    // Intro renders on the poll route itself — never bounced to /login.
    await expect(page.getByTestId('poll-intro-start')).toBeVisible();
    expect(page.url()).toContain(`/poll/${token}`);
    await page.getByTestId('poll-intro-start').click();

    // The seed card is the fake Now Playing surface; previews stream with the
    // short-lived media JWT in the query (the share-token pattern).
    await expect(page.getByTestId('poll-seed-card')).toBeVisible();
    await page.getByTestId('poll-play').first().click();
    await expect(page.locator('audio')).toHaveAttribute('src', /token=/);

    // Rate every scenario until the thanks screen.
    for (let guard = 0; guard < 10 && !(await page.getByTestId('poll-done').isVisible()); guard++) {
      await rateScenario(page);
    }
    await expect(page.getByTestId('poll-done')).toBeVisible();
    await ctx.close();

    // Admin results carry the votes (every candidate got exactly one).
    const results = await request.get(`/api/admin/radio-polls/${id}`, {
      headers: bearer(adminToken),
    });
    expect(results.status()).toBe(200);
    const body = (await results.json()) as {
      poll: { voteCount: number; raterCount: number };
      scenarios: Array<{ candidates: Array<{ up: number; down: number }> }>;
    };
    const candidateCount = body.scenarios.reduce((n, s) => n + s.candidates.length, 0);
    expect(body.poll.voteCount).toBe(candidateCount);
    expect(body.poll.raterCount).toBe(1);
  });

  test('the admin card lists the poll', async ({ page, request }) => {
    await createPoll(request);
    await page.goto('/admin');
    await expandGroup(page, 'radio-polls');
    await expect(page.getByTestId('radio-polls-card')).toBeVisible();
    await expect(page.getByTestId('radio-polls-row').first()).toBeVisible();
    await expect(page.getByTestId('radio-polls-copy').first()).toBeVisible();
  });

  test('a closed poll answers 410 and the page explains itself', async ({
    request,
    browser,
    baseURL,
  }) => {
    const { id, token, adminToken } = await createPoll(request);
    const closed = await request.post(`/api/admin/radio-polls/${id}/close`, {
      headers: bearer(adminToken),
    });
    expect(closed.status()).toBe(200);

    const ctx = await browser.newContext({ baseURL: baseURL ?? undefined });

    // The public API refuses with a typed 410, not a 401 (which would bounce
    // the SPA to /login) and not a 500.
    const view = await ctx.request.get(`/api/radio-polls/public/${token}`);
    expect(view.status()).toBe(410);
    expect(((await view.json()) as { code: string }).code).toBe('POLL_CLOSED');

    const vote = await ctx.request.post(`/api/radio-polls/public/${token}/votes`, {
      data: { raterKey: 'anon-rater-e2e', votes: [] },
    });
    expect(vote.status()).toBe(410);

    const page = await ctx.newPage();
    await page.goto(`/poll/${token}`);
    await expect(page.getByTestId('poll-unavailable')).toBeVisible();
    await ctx.close();
  });

  test('the admin surface is admin-only', async ({ request }) => {
    // Unauthenticated: the blanket /api/admin/* auth prefix applies.
    const res = await request.get('/api/admin/radio-polls');
    expect(res.status()).toBe(401);
  });
});
