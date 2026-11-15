# iOS Simulator e2e lane

**Status:** built 2026-11-15. A manual GitHub Actions workflow, `.github/workflows/ios-simulator.yml`.
Run it from Actions → "iOS simulator" → Run workflow, or `gh workflow run ios-simulator.yml`. About
16 minutes a run; all 10 checks pass (run 43711192318, iPhone 17 Pro simulator, iOS 26).

**Why it exists.** No other lane runs the iOS app. The Android lanes ([e2e-tv-emulator.md](e2e-tv-emulator.md))
drive real APKs, and the Chromium suite ([e2e.md](e2e.md)) runs desktop Chromium. iOS WebKit
(WKWebView) has its own keyboard, viewport and media behaviour, and the iOS bugs filed so far live there
(#1635, #1531). Apple's Simulator only runs on macOS, so this lane cannot be local on Linux. GitHub's
macOS runners are free on a public repository.

## Running it

Nothing to set up. The workflow does everything on a `macos-26` runner (Capacitor 8 needs Xcode 26):

1. Build the web app, generate the iOS project (`cap add ios --packagemanager CocoaPods`, as
   `deploy.yml` does), patch `Info.plist` (`scripts/ios-plist.ts`, for ATS) and build a **Debug Simulator**
   app, unsigned.
2. Boot the newest available iPhone simulator (`ios/pick-simulator.ts`, `pickSimulator` in `ios/lane.ts`).
3. Install Appium and its XCUITest driver at pinned versions, and start Appium.
4. Start a throwaway server on port 8591 with a copy of the fixture music. The Simulator shares the Mac's
   network, so the app reaches it at `http://localhost:8591` with no tunnel.
5. Run `packages/e2e/ios/run.ts`.

Every step is recorded and screenshotted whether it passes or not. The artifact `ios-simulator-results`
holds `report.json`, one PNG per step, `appium.log`, `server.log` and the app's unified log. On a runner
nobody can log into, that artifact is the debugging session.

## Design decisions

- **Appium, not Playwright.** Playwright's WebKit is desktop WebKit and it has no iOS device API, so it
  cannot attach to an app's WKWebView. Appium's XCUITest driver attaches through the same remote inspector
  Safari uses, and switches between the page (`WEBVIEW_…` context) and native UI (`NATIVE_APP`).
- **No client library.** `ios/webdriver.ts` speaks the dozen W3C WebDriver endpoints over `fetch`. A
  client library would add a lockfile dependency for one manual job.
- **An inspectable WebView.** Appium attaches through the Simulator's web inspector, which lists a
  WKWebView only when it is marked inspectable. A Debug build alone did not do it: the inspector listed no
  web apps (measured 2026-11-15). So the workflow sets `ios.webContentsDebuggingEnabled` in the generated
  `capacitor.config.json` of its throwaway project, then checks that the built `.app` carries it. The
  committed config and the release build are untouched.
- **`additionalWebviewBundleIds: ['process-App']`.** The Simulator's web inspector reports the app as
  `process-App`, after its executable, not as `ar.kevinroberts.nicotind`. Appium matches web apps by
  bundle id, so it listed the page and then skipped it (measured 2026-11-15). The entry names the app
  exactly rather than `*`, so the lane cannot attach to another process's page.
- **Headless, and WebDriverAgent outside the session.** The workflow boots the Simulator with
  `simctl boot` and passes `isHeadless: true`. Without it Appium restarted the Simulator to show its
  window, and that boot overran its 120 s budget. WebDriverAgent is built and started in workflow steps
  (the start waits on `:8100/status`), and Appium attaches with `webDriverAgentUrl`. Started inside the
  session, its start-up took from 90 s to over 300 s across runs, and past 300 s the session request
  died on the client's `fetch` limit.
- **Real taps where the app listens for touch.** WebDriver's element click inside a page is a synthetic
  JavaScript click. The Play button accepts it. The mini player did not open Now Playing for it, so the
  lane taps the title natively (W3C actions in `NATIVE_APP`).
- **One calibration tap.** Gestures are native (`NATIVE_APP` W3C actions, screen points), while element
  positions come from the page (CSS pixels). On iOS a CSS pixel is a point, so one tap at a known screen
  point, plus the `clientX/Y` the page records for it, gives the whole mapping (`viewportOffset`). That
  avoids assuming anything about safe areas, `contentInset: 'always'` or the status bar.
- **Haptics are checked at the bridge, against the setting.** The Simulator plays no haptics and logs none. The page wraps
  `Capacitor.toNative`, the single function every plugin call crosses, and the lane asserts that a
  committed skip calls `Haptics.impact` once and a cancelled swipe calls nothing. That proves the wiring
  from gesture to native plugin. It does not prove the Taptic Engine fires; only a device can.

## Checks

`run.ts`, in order:
1. The server signs in and has a scanned album.
2. An Appium session starts on the Simulator.
3. The app's WebView is attachable, on `capacitor://localhost`.
4. The page signs in by seeding `localStorage` and opens the album.
5. The bridge spy is installed.
6. Play the album; a player title appears.
7. Calibrate page → screen with one tap on the album heading, which ignores taps. Measured offset: 0, 0,
   because the WebView fills the screen.
8. Open Now Playing with a real tap on the mini player; the cover settles fully on screen.
9. A committed swipe on the cover (260 points against `SKIP_THRESHOLD_PX` 80) skips and calls
   `Haptics.impact` once. Measured: "Opening Static" → "Second Wind", one call.
10. A 15-point swipe neither skips nor calls Haptics.
11. Turn haptics Off as a user would: close the sheet, open Settings from the tab bar, expand Playback &
    Offline, press Off.
12. The same committed swipe still skips and now calls nothing. This runs every time, so check 9's
    "once" cannot come from a spy that counts everything: the count has to follow the setting.

**Cost per run** (run 43711192318): web build 23 s, Simulator app build 1.5 min, Simulator boot 2 min,
Appium install 1.5 min, WebDriverAgent build 4 min, the checks 3.7 min.

## Not covered yet

- **#1635** (the mini player and tab bar float mid-screen after the keyboard closes). This lane is the one
  place it can be reproduced. `connectHardwareKeyboard: false` already makes the Simulator show the
  software keyboard. The check is: type in the library find box, tap a result with the keyboard up, then
  assert where the player bar sits and what `visualViewport.offsetTop` reads.
- **#1531** (background advance, far-seek stalls, the gap between tracks).
- How a haptic feels, on any platform.
