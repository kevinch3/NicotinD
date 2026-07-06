import { test, expect } from '@playwright/test';

test.describe('e-ink theme', () => {
  // Regression guard for the e-paper legibility fix: stroked icons "blended"
  // into the page because a 2-user-unit stroke flattens to a faint line on
  // e-ink. styles.css bumps `[data-theme=eink] svg { stroke-width: 3 }`.
  test('thickens icon strokes versus the default theme', async ({ page }) => {
    await page.goto('/library');
    await page.locator('svg').first().waitFor();

    const strokeFor = (theme: string) =>
      page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
        const svg = document.querySelector('svg');
        return svg ? parseFloat(getComputedStyle(svg).strokeWidth) : NaN;
      }, theme);

    const def = await strokeFor('midnight');
    const eink = await strokeFor('eink');

    expect(eink).toBeGreaterThanOrEqual(3);
    expect(eink).toBeGreaterThan(def);
  });
});

test.describe('theme utilities + contrast', () => {
  // Guards the audit fixes: themed utilities that were used in templates but
  // never registered rendered as no-ops (wrong/absent colour), and hardcoded
  // tints went low-contrast on light themes. Probe the computed colours on a
  // *light* theme (daylight) where those bugs are visible.
  const probe = (page: import('@playwright/test').Page, theme: string) =>
    page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      const mk = (cls: string) => {
        const el = document.createElement('div');
        el.className = cls;
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { color: cs.color, bg: cs.backgroundColor, border: cs.borderColor };
        el.remove();
        return out;
      };
      return {
        onAccent: mk('text-theme-on-accent'),
        borderSurface2: mk('border border-theme-surface-2'),
        statusWarn: mk('status-warn'),
        textStatusWarn: mk('text-status-warn'),
      };
    }, theme);

  test('registered utilities resolve to real, contrasting colours (daylight)', async ({ page }) => {
    await page.goto('/library');
    const r = await probe(page, 'daylight');

    // text-theme-on-accent → daylight --theme-on-accent (#ffffff), not a no-op.
    expect(r.onAccent.color).toBe('rgb(255, 255, 255)');
    // border-theme-surface-2 → daylight --theme-surface-2 (#e4e4e7), not the
    // transparent/currentColor fallback the unregistered class produced.
    expect(r.borderSurface2.border).toBe('rgb(228, 228, 231)');
    // status-warn pill: bg + text both resolve from tokens and are legible
    // (dark amber text on light amber bg — the old text-amber-400 was invisible).
    expect(r.statusWarn.bg).toBe('rgb(254, 243, 199)'); // #fef3c7
    expect(r.statusWarn.color).toBe('rgb(146, 64, 14)'); // #92400e
    expect(r.statusWarn.color).not.toBe(r.statusWarn.bg);
    expect(r.textStatusWarn.color).toBe('rgb(146, 64, 14)');
  });

  test('on-accent flips to a dark foreground on light accents (oled)', async ({ page }) => {
    await page.goto('/library');
    const r = await probe(page, 'oled');
    // oled accent (#818cf8) is light → on-accent is dark (#0a0a0a), so text on
    // an accent pill stays legible instead of the old hardcoded white.
    expect(r.onAccent.color).toBe('rgb(10, 10, 10)');
  });
});
