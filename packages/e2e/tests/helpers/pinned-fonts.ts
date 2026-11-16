import type { Page } from '@playwright/test';

/**
 * Pin the fonts a screenshot baseline depends on (docs/e2e.md "A screenshot
 * baseline is a Linux rendering with pinned fonts"): DejaVu Sans, DejaVu Sans
 * Mono and Noto Color Emoji, which every Ubuntu image and Playwright's
 * `install-deps` provide. Call before the first navigation.
 */
export async function pinFonts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const install = (): void => {
      const style = document.createElement('style');
      style.setAttribute('data-e2e-pinned-fonts', '');
      style.textContent =
        '*, *::before, *::after { font-family: "DejaVu Sans", "Noto Color Emoji", sans-serif !important; }' +
        'code, pre, .font-mono { font-family: "DejaVu Sans Mono", monospace !important; }';
      document.head.appendChild(style);
    };
    if (document.head) install();
    else document.addEventListener('DOMContentLoaded', install);
  });
}
