# Store images (phone entry)

`icon.png` (512×512) is generated from `packages/mobile/assets/icon-only.png`.

`phoneScreenshots/` is **empty on purpose**. F-Droid does not require screenshots, and the only
library the fixture-based Playwright harness has is the e2e fixture — one album called "E2E Test
Album" with a noise-pattern cover. Those are the right screenshots for the README, where the reader
knows what a test fixture is, and the wrong ones for a store listing, where they read as "this app
has nothing in it".

To add real ones, capture against a library with actual content:

- `packages/e2e/playwright.live-screens.config.ts` is the existing hook — it runs against
  `E2E_BASE_URL` with `PLAYGROUND_USERNAME`/`PLAYGROUND_PASSWORD` and refuses to start without them.
- It cannot simply be pointed at `mobile-screenshots.screens.ts`: that spec clicks albums by their
  fixture names (`FIXTURE.album.title`), so a live capture needs a spec that navigates generically
  (first album card, first track) instead.

Drop PNGs in here named `1-*.png`, `2-*.png`, … — F-Droid orders them by file name. Portrait phone
dimensions; the harness's Pixel 7 viewport gives 1082×2202, which is fine.

`featureGraphic.png` (1024×500) is also absent: the only banner asset in the repo is the Android TV
one at 320×180, too small to upscale. It is optional.
