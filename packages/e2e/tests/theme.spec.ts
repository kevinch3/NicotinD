import { test, expect, type Page } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';
import { composite, contrast, parseColor } from './helpers/contrast';

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

// The contrast table (#1684): every text and fill pair the themes promise, on
// every preset, measured from the computed tokens the page paints. A pill's
// translucent background is composited over `surface`, where pills sit; any
// other translucent token over `bg`. Targets: 4.5 for text, 3 for an accent
// used as a fill. → docs/web-ui.md "Theme System".
test.describe('theme contrast table', () => {
  const PRESETS = ['midnight', 'daylight', 'warm-paper', 'oled', 'twilight', 'forest', 'eink'];
  const TOKENS = [
    'bg',
    'surface',
    'surface-1',
    'surface-2',
    'text-primary',
    'text-secondary',
    'text-muted',
    'accent',
    'accent-text',
    'on-accent',
    'accent-2',
    'accent-2-text',
    'on-accent-2',
    'highlight-bg',
    'highlight-text',
    ...['progress', 'done', 'warn', 'error'].flatMap((k) => [`status-${k}-bg`, `status-${k}-text`]),
  ];
  type Pair = [fg: string, bg: string, target: number, over?: 'bg' | 'surface'];
  const PAIRS: Pair[] = [
    ['text-primary', 'bg', 4.5],
    ['text-primary', 'surface-2', 4.5],
    ...['text-secondary', 'text-muted', 'accent-text', 'accent-2-text'].flatMap((fg) =>
      ['bg', 'surface', 'surface-2'].map((on): Pair => [fg, on, 4.5]),
    ),
    ['on-accent', 'accent', 4.5],
    ['on-accent-2', 'accent-2', 4.5],
    ['accent', 'bg', 3],
    ['accent-2', 'bg', 3],
    ['highlight-text', 'highlight-bg', 4.5, 'surface'],
    ...['progress', 'done', 'warn', 'error'].map((k): Pair => [
      `status-${k}-text`,
      `status-${k}-bg`,
      4.5,
      'surface',
    ]),
    ['status-error-text', 'bg', 4.5],
  ];

  test('every pair meets its target on every preset', async ({ page }) => {
    await page.goto('/library');
    const failures: string[] = [];
    for (const preset of PRESETS) {
      const raw = await page.evaluate(
        ({ preset, names }) => {
          document.documentElement.setAttribute('data-theme', preset);
          const cs = getComputedStyle(document.documentElement);
          return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--theme-${n}`)]));
        },
        { preset, names: TOKENS },
      );
      const bg = parseColor(raw['bg']!);
      const opaque = (name: string, over: 'bg' | 'surface' = 'bg') => {
        const c = parseColor(raw[name]!);
        if (c.a === 1) return c;
        return composite(c, over === 'bg' ? bg : composite(parseColor(raw['surface']!), bg));
      };
      for (const [fg, on, target, over] of PAIRS) {
        const ratio = contrast(opaque(fg, over), opaque(on, over));
        if (ratio < target)
          failures.push(`${preset}: ${fg} on ${on} = ${ratio.toFixed(2)} < ${target}`);
      }
      expect(raw['surface-1'], `${preset}: surface-1 aliases surface`).toBe(raw['surface']);
    }
    expect(failures).toEqual([]);
  });
});

// Per-user preferences (#1299): the theme and language a person chooses reach
// the server and come back on a device that has never seen them. Wiping only
// the device keys (never the session token) is what "another device" means here.
test.describe('per-user preferences', () => {
  const DEVICE_KEYS = ['nicotind-theme', 'nicotind-lang', 'nicotind-prefs'];
  const wipeDeviceKeys = (page: Page) =>
    page.evaluate((keys) => keys.forEach((k) => localStorage.removeItem(k)), DEVICE_KEYS);

  test.afterEach(async ({ page }) => {
    // Leave the shared admin as other specs expect it.
    await page.goto('/settings');
    await expandGroup(page, 'settings-appearance');
    await page.locator('button[data-theme="midnight"]').click();
    await page.getByTestId('settings-language').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  });

  test('theme and language survive a wipe of the device keys', async ({ page, request }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    await page.goto('/settings');
    await expandGroup(page, 'settings-appearance');
    await page.locator('button[data-theme="eink"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'eink');
    await page.getByTestId('settings-language').selectOption('es');
    await expect(page.getByTestId('settings-language')).toHaveValue('es');
    // Let the PATCHes land before the reload races them.
    await expect
      .poll(async () => {
        const res = await request.get('/api/me/preferences', { headers: bearer(token) });
        const body = (await res.json()) as { theme: string | null; language: string | null };
        return `${body.theme}/${body.language}`;
      })
      .toBe('eink/es');

    await wipeDeviceKeys(page);
    await page.reload();
    await expandGroup(page, 'settings-appearance');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'eink');
    await expect(page.getByTestId('settings-language')).toHaveValue('es');
  });
});
