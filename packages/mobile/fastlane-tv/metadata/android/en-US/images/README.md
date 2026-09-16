# Store images (TV entry)

`icon.png` (512×512) is generated from `packages/mobile/assets/icon-only.png`.

`tvScreenshots/` is **empty on purpose**, for a harder reason than the phone entry's.

The TV UI is a *build-time* route fork (`ng build --configuration tv` → `isTvBuild()` true), so it
cannot be captured by pointing an existing spec at a different viewport — stamping a TV class on the
phone bundle renders the phone routes. Capturing it needs the TV bundle, its own server and its own
capture spec. The pieces exist (`packages/e2e/playwright.config.ts`'s `tv` project already builds
and serves that bundle at 960×540 for the Chromium TV assertions), but wiring a screenshot flow onto
them is unbuilt work.

It also needs a library with real content for the same reason as the phone entry — the e2e fixture's
single "E2E Test Album" makes a store listing look empty.

Drop PNGs in here named `1-*.png`, `2-*.png`, … — F-Droid orders them by file name. Landscape, 16:9.

`banner.png` for the Android TV home row is a *packaged* asset, not store metadata: it already ships
at `packages/mobile/android/app/src/main/res/drawable-xhdpi/banner.png` (320×180) and is asserted by
`packages/mobile/src/android-manifest.test.ts`.
