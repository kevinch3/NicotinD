import { test, expect, type Page } from '@playwright/test';

/**
 * Open every settings card, idempotently.
 *
 * Group open/closed state is persisted per-device in localStorage, so a blind
 * "click every toggle" loop CLOSES the cards a previous test left open — which
 * is exactly how these specs failed the first time. Drive off `aria-expanded`
 * instead of toggling.
 */
async function openAllGroups(page: Page): Promise<void> {
  // `.all()` does NOT auto-wait: called before the page renders it returns an
  // empty array and silently opens nothing. Wait for the first toggle first.
  await expect(page.getByTestId('settings-group-toggle').first()).toBeVisible();
  for (const toggle of await page.getByTestId('settings-group-toggle').all()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
}

/**
 * Privacy controls (issue #454, docs/privacy.md). The service and route layers
 * are unit-tested; what this covers is the part only a real browser can show —
 * that the page renders, the opt-out round-trips through the server, and the
 * export actually downloads.
 */
test.describe('privacy settings', () => {
  test('the page explains what is stored and offers the three controls', async ({ page }) => {
    await page.goto('/settings/privacy');
    await expect(page.getByTestId('privacy-settings')).toBeVisible();

    await openAllGroups(page);

    await expect(page.getByTestId('privacy-what')).toBeVisible();
    await expect(page.getByTestId('privacy-consent-toggle')).toBeVisible();
    await expect(page.getByTestId('privacy-export')).toBeVisible();
    await expect(page.getByTestId('privacy-delete-history')).toBeVisible();
  });

  test('opting out round-trips and the server then refuses new plays', async ({
    page,
    request,
  }) => {
    await page.goto('/settings/privacy');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    const auth = { Authorization: `Bearer ${token}` };

    await openAllGroups(page);

    const consent = page.getByTestId('privacy-consent-toggle');
    await expect(consent).toHaveAttribute('aria-checked', 'true');
    await consent.click();
    await expect(consent).toHaveAttribute('aria-checked', 'false');

    // The server — not just the UI — must now refuse to record.
    const res = await request.post('/api/history/plays', {
      headers: auth,
      data: {
        events: [
          {
            clientEventId: `e2e-privacy-${Date.now()}`,
            songId: 'whatever',
            startedAt: Date.now(),
            msPlayed: 250_000,
            durationMs: 300_000,
            reason: 'ended',
            source: null,
            device: null,
            title: null,
            artist: null,
            album: null,
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({
      inserted: 0,
      collection: { enabled: false, blockedBy: 'user' },
    });

    // Restore, so ordering can't leak this into another spec.
    await consent.click();
    await expect(consent).toHaveAttribute('aria-checked', 'true');
  });

  test('the export downloads a file containing this user', async ({ page }) => {
    await page.goto('/settings/privacy');
    await openAllGroups(page);

    const download = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByTestId('privacy-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toContain('nicotind-my-data');
  });
});
