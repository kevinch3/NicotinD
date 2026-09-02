import { test, expect, type Page } from '@playwright/test';

/**
 * Runtime network detection (the offline crash/UX fix). The app now folds a live
 * connectivity signal into `SetupService.isOffline()`, so dropping/regaining the
 * network mid-session is reflected immediately — an offline banner appears and
 * the shell reacts, without a reload. In the browser the signal is driven by
 * `navigator.onLine` + window online/offline events, which Playwright's
 * `context.setOffline()` emulates; the native shell uses @capacitor/network.
 *
 * Flake note (issues #362, #483): `setOffline()` emulates at the network layer
 * via CDP, but delivery of the window `online`/`offline` DOM events proved
 * flaky under CI load, so after each `setOffline()` flip we dispatch the
 * corresponding DOM event explicitly: deterministic event delivery, while
 * `setOffline()` still provides the real network-level failure underneath.
 *
 * That was not the whole story — the flake survived it (#483). The remaining
 * cause was the specs' own first assertion: `toHaveCount(0)` on the banner is
 * satisfied *vacuously* by a page that has not rendered yet, so nothing stopped
 * the spec from dropping the network while the SPA was still booting. See
 * `expectBootedShell` below for why that is unrecoverable rather than early.
 */
async function flipConnectivity(
  context: { setOffline(offline: boolean): Promise<void> },
  page: { evaluate<T>(fn: (arg: T) => void, arg: T): Promise<void> },
  offline: boolean,
): Promise<void> {
  await context.setOffline(offline);
  await page.evaluate(
    (type) => window.dispatchEvent(new Event(type)),
    offline ? 'offline' : 'online',
  );
}
/**
 * Wait for the app shell to actually be on screen before asserting anything
 * about the offline banner (issue #483/#362).
 *
 * `expect(banner).toHaveCount(0)` is satisfied *vacuously* by a page that has
 * not rendered yet, so it was no barrier at all: the spec would drop the
 * network while the SPA was still booting. That is unrecoverable rather than
 * merely early — the remaining lazy route chunks can no longer load, so the
 * shell never mounts and the banner can never appear, which is exactly the
 * "element(s) not found" timeout reported. Under full-suite load the boot is
 * slower, which is why it only ever flaked there.
 *
 * `desktop-nav` is the shell's own marker (always in the DOM once the layout is
 * mounted; `hidden md:flex` only hides it visually), so this is a *positive*
 * signal that boot finished — an absence assertion is only meaningful after a
 * presence assertion. Reproduced deterministically by delaying the JS bundle
 * 1200ms: fails without this wait, passes with it.
 */
async function expectBootedShell(page: Page): Promise<void> {
  await expect(page.getByTestId('desktop-nav')).toBeAttached();
}

test.describe('offline network detection', () => {
  test('shows the offline banner when connectivity drops and hides it on reconnect', async ({
    page,
    context,
  }) => {
    // Boot online — the banner must not be present.
    await page.goto('/library');
    await expectBootedShell(page);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    // Drop the network mid-session: the banner appears reactively (no reload).
    await flipConnectivity(context, page, true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    // The Library stays reachable offline (it serves on-device downloaded tracks).
    await expect(page).toHaveURL(/\/library/);

    // Reconnect: the banner clears on its own.
    await flipConnectivity(context, page, false);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  });

  test('boots into a usable Library when the server is unreachable at launch', async ({ page }) => {
    // The crash scenario, browser analog: the native app bundles its assets (so
    // they load offline) but the API is unreachable. Block only /api/** so the
    // SPA loads while every backend call fails — the boot must still land on a
    // usable Library with the offline banner, not hang on a blank screen.
    await page.route('**/api/**', (route) => route.abort());

    await page.goto('/library');

    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page).toHaveURL(/\/library/);
  });

  // `serviceWorkers: 'block'` here is load-bearing, not hygiene (issue #564).
  // Once ngsw-worker.js takes control after boot, fetches originate from the
  // service worker, and Playwright's `page.route` does not intercept those — so
  // `route.abort()` silently becomes a no-op and the app never sees a failure.
  // That is exactly why this spec previously installed its abort mid-boot:
  // before the SW is in control, an abort still lands. Measured both ways: with
  // the SW active the aborted /api/search never fails and no /api/setup/status
  // probe is made (banner count 0); with it blocked, both happen and the banner
  // appears. Blocking is a faithful stand-in rather than a cheat — against a
  // genuinely dead server the SW's own network fetch fails too, which is the
  // situation being modelled.
  test.describe('mid-session server loss', () => {
    test.use({ serviceWorkers: 'block' });

    test('switches into offline mode by itself when the server dies mid-session, and recovers', async ({
      page,
      context,
    }) => {
      // Mid-session server loss: the device network stays up (navigator.onLine
      // is true throughout) but the API stops answering. The next API call fails
      // at the network level -> the interceptor reports it -> SetupService
      // verifies with a probe -> the app flips itself into offline mode.
      //
      // Boot fully first (issue #564). Without that wait the abort landed while
      // the app's own BOOT requests were still in flight, and those aborted boot
      // calls — not anything mid-session — were what drove it offline. The test
      // passed, but could not have caught a regression in the path it names.
      await page.goto('/library');
      await expectBootedShell(page);
      await expect(page.getByTestId('offline-banner')).toHaveCount(0);

      // Only now does the server "die".
      await page.route('**/api/**', (route) => route.abort());

      // A genuinely post-boot API call. The library find bar is the right
      // trigger: it goes through Angular's HttpClient (a raw fetch() would
      // bypass the interceptor, so `reportServerFailure` would never run),
      // /api/search is never served from the library read cache, and it needs no
      // navigation — so what fails is unambiguously a mid-session request rather
      // than a route load.
      await page.getByTestId('library-find').fill('anything');

      await expect(page.getByTestId('offline-banner')).toBeVisible();
      await expect(page).toHaveURL(/\/library/);

      // Server comes back + a device online event fires (the reconnect fast
      // path): the app re-probes immediately and leaves offline mode on its own.
      await page.unroute('**/api/**');
      await flipConnectivity(context, page, true);
      await flipConnectivity(context, page, false);

      await expect(page.getByTestId('offline-banner')).toHaveCount(0);
    });
  });
});

/**
 * The mosaic home offline (docs/web-ui.md "Mosaic home").
 *
 * Losing the network used to *navigate away* from home: `/` was the shell's
 * only online-only route, and `app.ts` redirected to `/library` on every
 * `isOffline()` flip. The mosaic now fills from the device's downloaded tracks
 * instead, so these assert the listener keeps the page they were on.
 */
test.describe('mosaic home offline', () => {
  test('stays on home when the network drops, and says what is going on', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await expectBootedShell(page);
    await expect(page.getByTestId('mosaic-home')).toBeVisible();

    await flipConnectivity(context, page, true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    // The regression this whole change is about: no redirect to /library.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('mosaic-home')).toBeVisible();

    // Nothing is downloaded in a fresh browser context, so the field is empty —
    // and must say *why*, not tell the listener to go add music.
    const empty = page.getByTestId('mosaic-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("You're offline");

    await flipConnectivity(context, page, false);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  });

  test('fills with the downloaded set and offers a way to the list', async ({ page, context }) => {
    // Visit the destination once while online first. `/library` is a lazy
    // route, and opening it offline is slow enough under load to dominate this
    // spec's timing (issue #872); warming it keeps the assertion about the
    // tile rather than about route-loading latency.
    await page.goto('/library');
    await expectBootedShell(page);

    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();

    // Seed the preserve store directly rather than driving auto-preserve.
    //
    // The realistic path — enable auto-preserve, play an album, poll until the
    // blobs land — takes ~40s and leaves side effects in the SHARED server
    // (stream reads, play events) and in the audio element, which is a poor
    // neighbour in an order-dependent suite. Reading the store directly is
    // already the established idiom here (see player.spec.ts). Meta rows are
    // enough on purpose: the mosaic renders from `preservedTracks`, which is
    // the meta store — the audio blob only matters once something plays.
    await seedPreserved(page, [
      { id: 'seed-1', title: 'Seeded One', artist: 'Offline Artist' },
      { id: 'seed-2', title: 'Seeded Two', artist: 'Offline Artist' },
    ]);
    await flipConnectivity(context, page, true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    // The field is now the downloaded set plus the one tile that navigates.
    const downloads = page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="downloads"]');
    await expect(downloads).toHaveCount(1, { timeout: 10_000 });
    const songs = page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="song"]');
    expect(await songs.count()).toBeGreaterThan(0);

    // That tile is the way to the downloads list, and navigates rather than plays.
    //
    // Generous timeout on purpose, and measured rather than guessed: offline,
    // this navigation took just over 5s under full-suite load — past
    // `toHaveURL`'s 5s default, which made it look like the click did nothing.
    // The navigation is slow, not cancelled (issue #872).
    //
    // 20s itself proved not generous enough (issue #878): three clean full
    // local runs — including a stash baseline on unmodified origin/master —
    // all timed out here, while CI stayed green (6m30s, this spec included)
    // and the spec alone was 6/6. That combination points at local CPU
    // contention rather than a defect: a shared dev box under full-suite load
    // can push this navigation well past 20s even though nothing regressed.
    // Widened rather than replaced with a condition-wait, because the thing
    // being waited on already *is* the real signal (the URL changing) — a
    // slow machine needs a bigger number, not a different check.
    await downloads.dispatchEvent('click');
    await page.waitForURL(/\/library/, { timeout: 45_000 });

    // Leave the context as it was found. Playwright gives each test its own
    // context, so this is hygiene rather than a fix — but a spec that ends with
    // the network switched off is a bad neighbour to inherit from.
    await flipConnectivity(context, page, false);
  });
});

/**
 * Write meta rows straight into the preserve store.
 *
 * Opened without a version, so this joins the database the app already created
 * at boot rather than racing it to define the schema — call it only after the
 * shell is up.
 */
const seedPreserved = (
  page: Page,
  rows: Array<{ id: string; title: string; artist: string }>,
): Promise<void> =>
  page.evaluate(
    (seed) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('nicotind-preserve');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('tracks')) {
            db.close();
            reject(new Error('preserve store not initialised — seed after the shell has booted'));
            return;
          }
          const tx = db.transaction('tracks', 'readwrite');
          const store = tx.objectStore('tracks');
          for (const [i, r] of seed.entries()) {
            store.put({
              ...r,
              album: 'Offline Album',
              size: 1024,
              format: 'flac',
              preservedAt: 1000 + i,
              lastAccessedAt: 1000 + i,
              source: 'user',
            });
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    rows,
  );
