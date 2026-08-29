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

  /** Star-rate every candidate in the visible scenario (5 on even rows, 1 on
   *  odd — the admin tally assertions can then see both ends), then advance —
   *  waiting for the step to actually change (the advance POSTs first), so the
   *  loop can't re-vote a scenario that is still submitting. */
  async function rateScenario(page: Page): Promise<void> {
    await expect(page.getByTestId('poll-scenario')).toBeVisible();
    const progress = await page.getByTestId('poll-progress').innerText();
    const rows = page.getByTestId('poll-candidate-row');
    const count = await rows.count();
    expect(count, 'a scenario should have at least one candidate').toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      const btn = rows.nth(i).getByTestId(i % 2 === 0 ? 'poll-rate-5' : 'poll-rate-1');
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

    // The playing row grows a seek bar (#803); scrubbing moves the audio clock.
    const seek = page.getByTestId('poll-seek');
    await expect(seek).toBeVisible();
    const range = seek.locator('input[type="range"]');
    await expect(range).toBeEnabled();
    for (let i = 0; i < 5; i++) await range.press('ArrowRight');
    await expect
      .poll(async () => page.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThan(0.2);
    // Pause hides it again — one slider exists only for the playing track.
    await page.getByTestId('poll-play').first().click();
    await expect(seek).toHaveCount(0);

    // Rate every scenario until the thanks screen.
    for (let guard = 0; guard < 10 && !(await page.getByTestId('poll-done').isVisible()); guard++) {
      await rateScenario(page);
    }
    await expect(page.getByTestId('poll-done')).toBeVisible();
    await ctx.close();

    // Admin results carry the votes (every candidate got exactly one rating).
    const results = await request.get(`/api/admin/radio-polls/${id}`, {
      headers: bearer(adminToken),
    });
    expect(results.status()).toBe(200);
    const body = (await results.json()) as {
      poll: { voteCount: number; raterCount: number; voteScale: string };
      scenarios: Array<{
        candidates: Array<{ meanRating: number | null; ratingCount: number }>;
      }>;
    };
    const candidateCount = body.scenarios.reduce((n, s) => n + s.candidates.length, 0);
    expect(body.poll.voteCount).toBe(candidateCount);
    expect(body.poll.raterCount).toBe(1);
    expect(body.poll.voteScale).toBe('stars5');
    // Every candidate got exactly one 5 or 1 — the graded tally must show it.
    for (const sc of body.scenarios) {
      for (const c of sc.candidates) {
        expect(c.ratingCount).toBe(1);
        expect([1, 5]).toContain(c.meanRating);
      }
    }
  });

  test('a rater can skip tracks or whole scenarios, and only given ratings count', async ({
    request,
    browser,
    baseURL,
  }) => {
    const { id, token, adminToken } = await createPoll(request);

    const ctx = await browser.newContext({ baseURL: baseURL ?? undefined });
    const page = await ctx.newPage();
    await page.goto(`/poll/${token}`);
    await page.getByTestId('poll-intro-start').click();

    // Every scenario step states the premise (issue #799).
    await expect(page.getByTestId('poll-framing')).toBeVisible();

    // First scenario: rate only the first candidate — Next must not force the rest.
    const firstStar = page.getByTestId('poll-candidate-row').first().getByTestId('poll-rate-4');
    await firstStar.click();
    await expect(firstStar).toHaveAttribute('aria-pressed', 'true');
    const progress = await page.getByTestId('poll-progress').innerText();
    await page.getByTestId('poll-next').click();
    await expect(
      page
        .getByTestId('poll-done')
        .or(page.getByTestId('poll-progress').filter({ hasNotText: progress })),
    ).toBeVisible();

    // Any remaining scenarios: skip outright with zero ratings — the advance
    // must not POST (the API rejects empty vote arrays) and still reach done.
    for (let guard = 0; guard < 10 && !(await page.getByTestId('poll-done').isVisible()); guard++) {
      await page.getByTestId('poll-next').click();
      await expect(
        page.getByTestId('poll-done').or(page.getByTestId('poll-submit-error')),
      ).toBeVisible();
      await expect(page.getByTestId('poll-submit-error')).toHaveCount(0);
    }
    await expect(page.getByTestId('poll-done')).toBeVisible();
    await ctx.close();

    // Exactly the one given rating landed — skipped candidates left no rows.
    const results = await request.get(`/api/admin/radio-polls/${id}`, {
      headers: bearer(adminToken),
    });
    expect(results.status()).toBe(200);
    const body = (await results.json()) as { poll: { voteCount: number } };
    expect(body.poll.voteCount).toBe(1);
  });

  test('a station scenario names its station and is votable', async ({
    request,
    browser,
    baseURL,
  }) => {
    // A station scenario has no seed song, so the wizard's `@if (sc.seed)` card
    // renders nothing — a rater would be grading an unexplained list of songs.
    // The fixture library carries no genre tags, so this uses a year station;
    // the genre grading itself is covered in radio.test.ts / station-affinity.
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const adminToken = ((await login.json()) as { token: string }).token;
    const created = await request.post('/api/admin/radio-polls', {
      headers: bearer(adminToken),
      data: {
        name: 'E2E station poll',
        scenarioCount: 1,
        nextUpCount: 2,
        filters: [{ yearMin: 2000, yearMax: 2030 }],
      },
    });
    expect(created.status(), 'station poll creation should succeed').toBe(201);
    const { token } = (await created.json()) as { token: string };

    const ctx = await browser.newContext({ baseURL: baseURL ?? undefined });
    const page = await ctx.newPage();
    await page.goto(`/poll/${token}`);
    await page.getByTestId('poll-intro-start').click();

    await expect(page.getByTestId('poll-station-card')).toBeVisible();
    await expect(page.getByTestId('poll-station-card')).toContainText('2000-2030');
    await expect(page.getByTestId('poll-seed-card')).toHaveCount(0);

    // The framing line names the station — the "what am I grading?" answer.
    await expect(page.getByTestId('poll-framing')).toBeVisible();
    await expect(page.getByTestId('poll-framing')).toContainText('2000-2030');

    await rateScenario(page);
    await expect(page.getByTestId('poll-done')).toBeVisible();
    await ctx.close();
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
