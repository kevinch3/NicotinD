import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../helpers';
import { ADMIN, bearer } from '../helpers';
import { startFixtureAddon, FIXTURE_ADDON_TOKEN, type FixtureAddon } from './helpers/fixture-addon';

const ADDON_ID = 'fixture-resource-addon';
const ADDON_AUTH = { Authorization: `Bearer ${FIXTURE_ADDON_TOKEN}` };
const ALTERNATE = 'other-peer';

/**
 * Re-sourcing a stuck download from another peer (#1065).
 *
 * The case this exists for: a hunt commits to one peer's folder, that peer
 * never uploads, and the card sits at "0 of N · PENDING" with nothing to do
 * about it but throw the job away. The assertion that matters is that the
 * replacement lands on the SAME card — a second card would be the old
 * cancel-and-re-hunt workaround with extra steps.
 */
test.describe('re-source a stuck download', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    // `conflictOnActiveAlbum` models the real addon's one-active-job-per-album
    // guard. Without it this spec passed against a double that could not
    // reproduce the failure that made the feature unusable in prod (#1069).
    addon = await startFixtureAddon({
      id: ADDON_ID,
      alternatePeer: ALTERNATE,
      conflictOnActiveAlbum: true,
    });
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    auth = bearer(((await login.json()) as { token: string }).token);

    const registered = await request.post('/api/plugins/addons', {
      headers: auth,
      data: { url: addon.url, token: FIXTURE_ADDON_TOKEN },
    });
    expect(registered.status()).toBe(201);
    const enabled = await request.post(`/api/plugins/${ADDON_ID}/enable`, {
      headers: auth,
      data: { consent: true },
    });
    expect(enabled.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    const res = await request.get('/api/downloads/jobs', { headers: auth });
    if (res.ok()) {
      const jobs = (await res.json()) as Array<{ id: string; method: string }>;
      for (const j of jobs.filter((j) => j.method === ADDON_ID)) {
        await request.delete(`/api/downloads/jobs/${j.id}`, { headers: auth }).catch(() => {});
      }
    }
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  /** Start a job on the original peer and wait for its card to offer a re-source. */
  async function stuckJob(request: APIRequestContext, album: string): Promise<string> {
    const created = await request.post(`${addon.url}/addon/v1/jobs`, {
      headers: ADDON_AUTH,
      data: { intent: 'album', artist: 'Addon Artist', album },
    });
    expect(created.status()).toBe(201);

    let jobId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return null;
          const jobs = (await res.json()) as Array<{
            id: string;
            method: string;
            albumTitle?: string | null;
            canResource?: boolean;
          }>;
          const job = jobs.find((j) => j.method === ADDON_ID && j.albumTitle === album);
          if (job) jobId = job.id;
          return job?.canResource ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    return jobId;
  }

  /** The peers a card is fetching from, once the replacement's items have mirrored in. */
  async function expectSources(request: APIRequestContext, jobId: string, peers: string) {
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          if (!res.ok()) return null;
          const jobs = (await res.json()) as Array<{ id: string; sources: { username: string }[] }>;
          const job = jobs.find((j) => j.id === jobId);
          return job ? job.sources.map((s) => s.username).join(',') : null;
        },
        { timeout: 25_000 },
      )
      .toBe(peers);
  }

  test('switches the pending track to the best peer by itself, on the same card', async ({
    page,
    request,
  }) => {
    const jobId = await stuckJob(request, 'Addon Album');

    await page.goto('/downloads');
    // Keyed on the job id, not the album title: the fixture payload's "Addon
    // Album" is shared with several other specs, whose cards are still in the
    // feed when the whole suite runs.
    const card = page.locator(`[data-testid="download-item"][data-job-id="${jobId}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // The action is reachable WITHOUT expanding — the stuck card is the point.
    await card.getByTestId('download-resource').click();

    // No dialog and no deadline: the search names its pick in a countdown and
    // then acts on it. The peer already on the job is never the pick — that is
    // the same dead end. Nothing below clicks the toast.
    const offer = page.getByTestId('toast').filter({ hasText: ALTERNATE });
    await expect(offer).toBeVisible({ timeout: 20_000 });
    await expect(offer.getByTestId('toast-progress')).toBeVisible();
    await expect(page.getByTestId('resource-picker')).toHaveCount(0);

    await expect(
      page.getByTestId('toast').filter({ hasText: `Re-sourcing 1 track(s) from ${ALTERNATE}` }),
    ).toBeVisible({ timeout: 20_000 });

    // The stuck job is released BEFORE the replacement is created (#1069). The
    // addon allows one active job per album, so the reverse order 409s — and
    // this assertion, not the test merely passing, is what states the rule.
    expect(addon.cancelRequests).toContain('fixture-job-1');

    // The replacement's item arrives on the SAME job, from the new peer, and
    // the abandoned row stops counting rather than doubling the tracklist.
    await expectSources(request, jobId, ALTERNATE);

    // Still one card: re-sourcing is not a second download.
    const cards = await request.get('/api/downloads/jobs', { headers: auth });
    const all = (await cards.json()) as Array<{
      id: string;
      method: string;
      items: { title: string }[];
    }>;
    expect(all.filter((j) => j.method === ADDON_ID)).toHaveLength(1);
    // And still one row for the track: the row reserved at commit (#1146) was
    // adopted by the replacement's report, not joined by a second one.
    expect(all.find((j) => j.id === jobId)!.items.map((i) => i.title)).toEqual(['Addon Song']);
  });

  // #1878: the second re-source on a card used to cancel `source_ref`'s first
  // job — long gone — and collide with the replacement still active, so the
  // real addon's one-active-album guard answered 409 on every click. Driven
  // through the route because the UI search rightly excludes both peers
  // already on the card, which leaves this fixture nobody new to offer.
  test('a second re-source on the same card releases the live replacement', async ({ request }) => {
    const jobId = await stuckJob(request, 'Addon Album Three');
    const resource = () =>
      request.post(`/api/downloads/jobs/${jobId}/resource`, {
        headers: auth,
        data: { candidateRef: 'fixture-candidate-2' },
      });

    const first = await resource();
    expect(first.status()).toBe(200);
    const replacement = ((await first.json()) as { addonJobId: string }).addonJobId;

    const second = await resource();
    expect(second.status()).toBe(200);
    expect(addon.cancelRequests).toContain(replacement);
  });

  test('Choose peer opens the picker on the search already run', async ({ page, request }) => {
    const jobId = await stuckJob(request, 'Addon Album Two');

    await page.goto('/downloads');
    const card = page.locator(`[data-testid="download-item"][data-job-id="${jobId}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByTestId('download-resource').click();

    const offer = page.getByTestId('toast').filter({ hasText: ALTERNATE });
    await expect(offer).toBeVisible({ timeout: 20_000 });
    await offer.getByRole('button', { name: 'Choose peer' }).click();

    // Listed at once: the dialog shows the search the countdown came from.
    const picker = page.getByTestId('resource-picker');
    await expect(picker.getByTestId('resource-alternate')).toHaveCount(1);
    await expect(picker.getByTestId('resource-alternate')).toHaveAttribute('data-peer', ALTERNATE);

    await picker.getByTestId('resource-confirm').click();
    await expect(picker).toBeHidden({ timeout: 15_000 });
    await expectSources(request, jobId, ALTERNATE);
  });
});
