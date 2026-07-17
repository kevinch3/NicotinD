import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * The post-login landing (route '') is the radio/mood starter: a resume shortcut
 * for the last track plus one-tap vibe presets. The /search page is reachable
 * from the desktop top-nav Search link and the mobile bottom-nav Search tab.
 * Acquisition stays default-off in e2e.
 */
test.describe('radio landing', () => {
  test('renders vibe presets and a custom builder', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('radio-preset').first()).toBeVisible();
    // The custom builder is wired (its Start-gating logic is unit-tested in
    // radio-landing.component.spec.ts).
    await expect(page.getByTestId('radio-custom-toggle')).toBeVisible();
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
