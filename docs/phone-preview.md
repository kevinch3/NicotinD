# Phone preview

Confirm a UI change on a real phone **before** it is merged or released. Some bugs only exist in iOS
WebKit (the standalone-PWA bottom band after #1646 is one): Chromium and CI cannot reproduce them, so
the only honest gate is the device.

```bash
bun run phone-preview        # builds this worktree's web bundle, serves it, exposes it tailnet-only
```

It prints `https://<this-machine>.ts.net:8443`. Open it on the phone (the phone must be on the same
tailnet), then Share → Add to Home Screen to get the **standalone** PWA, which is the mode that
differs from Safari. Ctrl-C stops the server and removes the Tailscale mapping.

## What it does and does not touch

- **Throwaway data.** A fixture library and its own data dir under `.tmp-preview/` (gitignored). Never
  prod data. The admin account you create on the phone persists there across runs.
- **Own origin.** A separate HTTPS port gives a separate PWA install, so it never mixes with the real app.
- **Tailnet only.** `tailscale serve`, never Funnel. Only the preview's own port (`PREVIEW_TS_PORT`,
  default 8443) is turned off on exit; any other serve/Funnel mapping on the machine is left alone.
- **Service worker.** The preview origin runs ngsw like a real deployment, so after rebuilding, close and
  reopen the PWA once to pick up the new bundle.

## Viewport readout

The staged `index.html` (never the shipped bundle) gets `scripts/phone-preview/overlay.js`: a small
overlay with `innerHeight`, `screen.height`, `visualViewport`, the resolved `dvh`/`svh`/`lvh`, the
safe-area insets, where `position: fixed; bottom: 0` really lands, and the **gap below the bottom nav**.
Tap it to collapse. `PREVIEW_OVERLAY=0` turns it off; `PREVIEW_SKIP_BUILD=1` reuses `packages/web/dist`.

## Release gate

For a change that only reproduces on-device, put the preview result (what the readout showed, and that
the owner confirmed on the phone) in the PR before merging.
