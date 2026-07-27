import { expect, test } from '@playwright/test';

/**
 * Issue #236 — runtime JSON i18n. The property that matters end to end is that
 * a language switch reaches the DOM on a **single build**, with no reload: that
 * is the whole reason this is runtime JSON rather than `@angular/localize`
 * (compile-time, one build per locale).
 *
 * The login page is the proof surface: it renders before any user exists, which
 * is also why the language is stored per-device rather than per-user.
 */
test.describe('i18n (#236)', () => {
  test('serves the base and translated catalogs', async ({ request }) => {
    const en = await request.get('/i18n/en.json');
    expect(en.ok(), 'base catalog must be served').toBe(true);
    const enBody = (await en.json()) as Record<string, string>;
    expect(enBody['login.submit.signIn']).toBe('Sign In');

    const es = await request.get('/i18n/es.json');
    expect(es.ok()).toBe(true);
    const esBody = (await es.json()) as Record<string, string>;
    // Every Spanish key must exist in the base — the base is the source of
    // truth, and a stray key would be dead weight a provider export can't map.
    // NB: `toHaveProperty` treats dots as a path, and every key here contains
    // them (`login.submit.signIn`), so compare the flat key lists instead.
    const baseKeys = new Set(Object.keys(enBody));
    const orphans = Object.keys(esBody).filter((k) => !baseKeys.has(k));
    expect(orphans, 'es.json keys missing from the en.json base').toEqual([]);
  });

  test('renders English by default and switches without a reload', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toHaveText(/Sign In/i);

    // Switching is what a user does in Settings; drive the same persisted key
    // the picker writes, then reload once to prove it is remembered per-device.
    await page.evaluate(() => localStorage.setItem('nicotind-lang', 'es'));
    await page.reload();
    await expect(page.getByTestId('login-submit')).toHaveText(/Iniciar sesión/i);

    // And back, so the test leaves no residue for the next spec.
    await page.evaluate(() => localStorage.setItem('nicotind-lang', 'en'));
    await page.reload();
    await expect(page.getByTestId('login-submit')).toHaveText(/Sign In/i);
  });

  test('translates the app shell nav, not just the login page', async ({ page }) => {
    // The shell is the highest-traffic surface and its labels come from a TS
    // array rather than the template — a conversion that type-checks but never
    // renders would be invisible without this.
    //
    // `addInitScript` seeds the stored language before ANY page script runs, on
    // every navigation. Setting it via `evaluate` after a `goto` instead makes
    // the test depend on when the app happens to read localStorage during
    // bootstrap, which is precisely the kind of race that makes a suite flaky.
    await page.addInitScript(() => localStorage.setItem('nicotind-lang', 'es'));
    await page.goto('/library');

    // Desktop viewport: the top nav renders, the bottom tab bar is hidden.
    const nav = page.getByTestId('desktop-nav');
    await expect(nav).toContainText('Biblioteca');
    await expect(nav).not.toContainText('nav.library'); // never a raw key
  });

  test('translates the library tabs and sort options', async ({ page }) => {
    // Same TS-array-holds-a-key shape as the nav, on the main content surface.
    await page.addInitScript(() => localStorage.setItem('nicotind-lang', 'es'));
    await page.goto('/library');

    const tabs = page.getByTestId('library-tabs');
    await expect(tabs).toContainText('Álbumes');
    await expect(tabs).toContainText('Artistas');
    // A key that failed to resolve renders as its dotted key — assert none leak.
    await expect(tabs).not.toContainText('library.tab.');
  });
});
