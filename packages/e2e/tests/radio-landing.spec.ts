import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * The post-login landing (route '') is the radio/mood starter: a resume shortcut
 * for the last track plus one-tap vibe presets. Search moved to /search, reached
 * from the landing's search doorway. Acquisition stays default-off in e2e.
 */
test.describe('radio landing', () => {
  test('renders vibe presets and a search doorway', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('radio-preset').first()).toBeVisible();

    // Search now lives at /search; the landing links to it.
    await page.getByTestId('radio-search-link').click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByTestId('search-input')).toBeVisible();
  });

  test('the custom builder gates Start until a criterion is picked', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('radio-custom-toggle').click();

    const start = page.getByTestId('radio-custom-start');
    await expect(start).toBeDisabled();

    // Picking a mood enables Start.
    await page.getByTestId('radio-custom').getByText('happy', { exact: true }).click();
    await expect(start).toBeEnabled();
  });

  test('resume-from-last-track appears after playback and disappears on tap', async ({ page }) => {
    // Play a fixture track so the player carries a "last track".
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('track-row').first()).toHaveAttribute(
      'data-playback-state',
      /buffering|playing/,
      { timeout: 15_000 },
    );

    // Land on the radio landing: the resume shortcut is offered.
    await page.goto('/');
    const resume = page.getByTestId('radio-resume');
    await expect(resume).toBeVisible();

    // Tapping it starts radio and the block disappears.
    await page.getByTestId('radio-resume-play').click();
    await expect(resume).toHaveCount(0);
  });
});
