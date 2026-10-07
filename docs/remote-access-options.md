# Remote access: which tunnel, and how to make it one click

> **Proposed, NOT built.** This is the decision record and plan for making "reach my server from
> the internet" a one-click onboarding step. What ships today is the Tailscale Funnel path in
> [device-pairing.md](device-pairing.md). Researched 2026-10.

## The question

A self-hoster installs NicotinD (desktop app, Docker, bare metal) and it works on their LAN. For it
to work **from anywhere**, and stay working, something has to carry public HTTPS to a machine that
sits behind a home router, often behind CGNAT. We want:

1. **As few third-party providers as possible.** Ideally one, and ideally not us.
2. **Safe by default.** The backend stays loopback-bound, opens no router ports, gets a real
   certificate, and is never exposed before it has been hardened.
3. **One click in onboarding**, verified by a real round trip over the internet, not just
   "the process started".
4. **Always on.** The host machine (often a Mac) has to stay awake and come back on its own after a
   reboot.

## Decision

**Keep Tailscale Funnel as the transport, and stop asking the user to install Tailscale.** Embed it.

The transport was never the problem. Funnel is still the best fit for this app. What makes it feel
"for technical users" is the packaging around it: install the Tailscale app, sign in, run a `sudo`
operator grant on Linux, approve Funnel, all before the toggle works. Those steps are
`not-installed` / `needs-login` / `needs-operator` / `funnel-not-enabled` in today's state machine
(`packages/api/src/services/tailscale.ts`), and three of them go away once Tailscale is embedded:

- Ship a small Go helper, `nicotind-tunnel`, built on Tailscale's **`tsnet`** library. `tsnet`
  runs a whole Tailscale node inside one user-space process, with no system VPN, no daemon, no
  admin rights and no kernel extension. `Server.ListenFunnel` returns a listener that already has
  a public `https://<name>.<tailnet>.ts.net` hostname and a valid TLS certificate.
- The helper proxies that listener to `127.0.0.1:<port>`, the same thing `tailscale funnel` does
  today, so nothing else in the backend changes.
- Onboarding becomes: **Turn on internet access**, then the browser opens Tailscale's sign-in
  (Google / Apple / Microsoft / GitHub, one click for most people), then the app shows the verified
  public URL. At most one more click if the tailnet still needs Funnel approved.
- The same binary works in Docker (state in the data volume), which also fixes today's
  "`not-installed` in containers" gap.
- Users who already run Tailscale keep the existing CLI path. It is the fallback, not the default.

One provider (Tailscale), and the user owns the account. Traffic never touches our infrastructure,
so we pay nothing per user and we are not the operator of a relay carrying other people's music
libraries. That second point matters more than it looks for an app with acquisition addons.

**Second tier, behind an "Advanced" disclosure:** *Use my own domain (Cloudflare)*, for people who
own a domain and want a custom hostname or more bandwidth. **Third tier:** *I already have a reverse
proxy or VPN*, where the user pastes a URL. All three tiers go through the same verification below.
This is the second provider that the `connectivity` plugin kind
(`packages/core/src/plugin/capabilities.ts`) has been waiting for.

## Options compared

| | Tailscale Funnel (embedded `tsnet`) | Cloudflare Tunnel, own domain | Cloudflare Quick Tunnel | ngrok | Our own relay (Pangolin / frp on a VPS) |
|---|---|---|---|---|---|
| Accounts the user needs | Tailscale (SSO) | Cloudflare **plus a domain** on it | none | ngrok | none |
| Stable URL | yes (`*.ts.net`) | yes (custom) | **no**, new random URL each restart | 1 free static dev domain | yes (`*.nicotind.app`) |
| Free-tier limits that matter | throttled bandwidth, numbers unpublished | none published; 100 MB request body | **no SSE**, 200 in-flight requests, no SLA | **1 GB/month, 20k requests/month**, browser interstitial | whatever we pay for |
| Fits music streaming | yes for lossy; lossless may stutter | yes | no (we use SSE and WebSockets) | no (1 GB is about 17 h of 128 kbps) | yes |
| Terms risk | low | grey area (CDN terms restrict "large files" served from outside Cloudflare) | n/a | paid plan needed for real use | **we carry the liability** |
| Who is in the data path | Tailscale | Cloudflare | Cloudflare | ngrok | **us** |
| Embeddable, no install | yes (`tsnet`, Go) | `cloudflared` binary plus a token | `cloudflared` binary | `@ngrok/ngrok` SDK | client binary |

Why each alternative loses:

- **Cloudflare Tunnel** is a very good transport, but the free, stable version needs a domain on
  Cloudflare. "Buy a domain, move its DNS" is a bigger ask than "sign in with Google". The
  unauthenticated Quick Tunnel has no stable URL and no SSE support (NicotinD uses SSE for library
  events), so it cannot back a QR-paired phone. A version where *we* create a tunnel per user under
  a `nicotind.app` zone through the Cloudflare API would be truly zero-account for the user. It
  would also put every customer's traffic on our Cloudflare account and terms, so one abuse report
  could take everyone down. We keep Cloudflare only as the bring-your-own-domain tier.
- **ngrok**'s free plan was cut in February 2026 to 1 GB/month and 20k requests/month, and it shows
  a warning page in browsers. A single evening of listening (cover art, API calls, audio) uses that
  up. The embeddable SDK is nice, but the product needs a paid plan for every user.
- **Running our own relay** gives the best UX (no account at all) but turns us into a hosting
  company: bandwidth cost grows with every listener, there is an ops pager, and we would be relaying
  libraries filled by acquisition addons. Revisit only as a paid tier, if customers ask for it.
- **UPnP / port forwarding + DDNS** fails behind CGNAT and exposes the box directly. Not a default.
- **Tailscale on both devices** (no Funnel) is the most private option, but it needs the Tailscale
  app on every phone. Keep it as a later "LAN-speed at home" candidate URL, as
  [device-pairing.md](device-pairing.md) already says.

Funnel's trade-offs, accepted: the hostname is `*.ts.net` (no custom domain on this tier), Funnel
listens only on ports 443/8443/10000, and its bandwidth throttle is not published. The verifier
below **measures** throughput instead of guessing, and remote playback picks a transcode quality to
match.

## Verification: prove it works from the internet

"Funnel armed" is not the same as "a phone on 4G can reach it". The panel shows a checklist where
each row is a typed state, the same pattern as `RemoteAccessState`, and only an all-green list says
**Reachable from the internet**.

1. **Hardened** (a gate, checked *before* arming). Setup is complete, the admin password passes a
   strength check, self-registration is off (or the user confirms it on purpose), and **login is
   rate-limited**. Today `POST /api/auth/login` has no limiter; only the pairing claim does
   (`routes/devices.ts`). That has to land before internet access becomes one click.
2. **Tunnel up.** The helper reports it is logged in, the Funnel listener is bound, and the
   certificate was issued. Each failure maps to its own action (sign in, approve Funnel, retry).
3. **Public DNS.** Resolve the hostname through public DNS-over-HTTPS (1.1.1.1 / 8.8.8.8), **not**
   the OS resolver. On a machine running Tailscale, MagicDNS answers `*.ts.net` with a 100.x tailnet
   address, so a self-check through the local resolver passes even when the public path is broken.
4. **External round trip.** A vantage point *outside* the network fetches
   `https://<host>/api/remote-access/probe?nonce=<n>`, and the server answers with an HMAC of the
   nonce under a per-install secret. That proves the public path, the TLS certificate, **and** that
   it reached *this* server, not a stale node or someone else's. The vantage point is a tiny
   stateless Cloudflare Worker that we run (`probe.nicotind.app`). It only ever sees a nonce, never
   music or credentials. Fallback when it is unreachable: connect to the DoH-resolved public address
   with SNI set (hairpinning out through Funnel's edge).
5. **Quality.** Download a fixed 2 MB probe blob over the same path and record throughput and
   latency. Show "Lossless OK" or "Remote streams will use Opus 192", and feed that into the
   remote-playback transcode default (the helper tags proxied requests so the backend knows which
   ones came through the tunnel).
6. **Still reachable** (continuous). Re-probe every 15 minutes and after the OS wakes from sleep.
   On failure, re-arm automatically, and surface "Internet access down since 14:02" in the panel and
   in the desktop tray. The phone's pairing probe (`candidateUrls()`) stays the last-mile check.

## Keeping the host awake (the Mac "daemon" settings)

A tunnel is only as available as the machine behind it. On macOS:

- **Prevent idle sleep while internet access is on.** Electron's
  `powerSaveBlocker.start('prevent-app-suspension')` keeps the system awake but lets the display
  sleep. It also stops App Nap from throttling the app. Make it a toggle that defaults on while on
  AC power (`powerMonitor.isOnBatteryPower()`). **Closing a laptop lid still sleeps the Mac.** The
  panel should say so and deep-link to System Settings → Battery → Options → *Prevent automatic
  sleeping on power adapter when the display is off*. Do not rely on *Wake for network access*: it
  wakes for Bonjour/LAN traffic, not Funnel.
- **Launch at login, without a window.** Use `app.setLoginItemSettings({ openAtLogin: true })`
  (Electron registers through `SMAppService` on macOS 13+), detect the login launch, and start in
  the menu bar only. That is a per-user LaunchAgent in effect, which is the right level: a
  system-wide LaunchDaemon (runs before anyone logs in) needs root and runs into privacy
  permissions on the music folder, and Mac users are logged in anyway.
- **No firewall prompt, no router change.** Both come from the loopback bind plus an outbound-only
  tunnel. Keep it that way. Binding `0.0.0.0` for direct LAN access would trigger the macOS
  Application Firewall prompt.
- **Signing is part of distribution.** The `.dmg` is ad-hoc signed today
  ([desktop-app.md](desktop-app.md)). macOS keys privacy grants (removable/network volumes, Local
  Network, firewall) to the code signature, and an ad-hoc signature changes every build, so users
  are re-prompted after **every update**, on top of Gatekeeper's "Open Anyway". A Developer ID plus
  notarization ($99/year) is arguably a bigger install-friction fix than the tunnel. The
  `nicotind-tunnel` binary must be signed with the app.
- **Local Network permission (macOS 15+)** is not needed for the tunnel: loopback and internet
  traffic are exempt. It only matters once NicotinD dials LAN devices (a NAS addon, cast targets).

Linux: a `systemd --user` unit plus `loginctl enable-linger`. Docker: `restart: unless-stopped`,
with the helper inside the container.

## Plan

| Phase | What | New dependencies |
|---|---|---|
| 1 | Login rate limit; the hardening gate; the verification checklist (steps 1–6) on today's CLI-based Funnel; keep-awake + launch-at-login in the desktop app | one stateless Worker |
| 2 | `nicotind-tunnel` (`tsnet`) bundled in the desktop app and Docker image as the default; the CLI path becomes the fallback | Go toolchain in CI (`CGO_ENABLED=0` cross-compile, roughly 25–30 MB per platform) |
| 3 | Move `RemoteAccess` behind the `connectivity` plugin kind; add the Cloudflare (own domain, `cloudflared` + tunnel token) and "custom URL" providers | `cloudflared` binary, optional download |
| 4 | Developer ID signing + notarization (also unlocks macOS auto-update) | Apple Developer Program |

Phase 1 is useful on its own and touches no new provider. Phase 2 is what makes it one click.

## Sources

- [Tailscale Funnel docs](https://tailscale.com/docs/features/tailscale-funnel.md): free on every
  plan, non-configurable bandwidth limits, ports 443/8443/10000.
- [`tsnet` package](https://pkg.go.dev/tailscale.com/tsnet@v1.98.2): `Server.ListenFunnel`;
  [Golang Weekly note](https://golangweekly.com/link/137000/web) on compiling Funnel into a program.
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/):
  200 in-flight requests, no SSE, testing only.
- [Create a remotely-managed tunnel via API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).
- [Cloudflare: "Goodbye section 2.8"](https://blog.cloudflare.com/updated-tos/): CDN terms on
  large files hosted outside Cloudflare.
- [ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits): 1 GB/month,
  20k requests/month, interstitial page.
- [zrok service limits](https://netfoundry.io/docs/zrok/myzrok/service-limits),
  [Pangolin overview](https://www.bitdoze.com/pangolin-cloudflare-tunnels-alternative/).
- [Electron `powerSaveBlocker`](https://www.electronjs.org/docs/api/power-save-blocker).
