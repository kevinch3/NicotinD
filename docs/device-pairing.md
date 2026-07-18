# Device pairing (QR link) + remote access (Tailscale Funnel)

How a phone (the Capacitor app) gets connected to a personal NicotinD server —
typically the Electron desktop app — **from anywhere, safely, in one scan**: the
server shows a QR code, the phone scans it, and it is connected *and* signed in.
No typed URLs, no typed passwords.

```
Phone (anywhere, plain HTTPS)
   └── https://<machine>.<tailnet>.ts.net   ← Tailscale Funnel (TLS termination + relay)
          └── tailscaled on the server host → 127.0.0.1:<port>   ← backend stays loopback-bound
```

Everything here is **server-generic**: the pairing API and the Devices page work
on any self-hosted deployment (Docker, bare metal, desktop). Nothing is
Electron-specific — the desktop sidecar keeps its loopback bind untouched,
because Funnel proxies to localhost.

## Why Tailscale Funnel (the transport decision)

Considered: LAN-only bind (doesn't work away from home), Tailscale on both
devices (most private, but requires the Tailscale app + account on the phone),
Cloudflare Tunnel (needs an owned domain), UPnP port-forward + DDNS (breaks on
CGNAT, exposes the box directly). **Funnel** was chosen because it's the best
easy/safe compromise for "phone reaches the desktop from anywhere":

- Only the **server host** runs Tailscale. The phone needs nothing installed —
  the QR carries a normal public HTTPS URL.
- The backend **stays loopback-bound** (`NICOTIND_BIND_HOST=127.0.0.1` on
  desktop); `tailscale funnel --bg <port>` proxies 443 → localhost. No bind
  changes, no firewall holes, no Android-cleartext / iOS-ATS work (Tailscale
  terminates real HTTPS with a real cert).
- Trade-offs, accepted and documented: the app becomes **publicly reachable**
  (the JWT login is the gate — use a strong password; claim is rate-limited),
  and streams relay through Tailscale's Funnel proxy, which is
  **bandwidth-throttled** — fine for lossy music, lossless may stutter.

Future work: a tailnet-direct candidate URL (phone also on Tailscale → LAN-speed
at home, no relay), and migrating this service into the scaffolded
`connectivity` plugin kind (`packages/core/src/plugin/capabilities.ts`) once a
second connectivity provider (WireGuard) exists.

## Funnel lifecycle (`packages/api/src/services/tailscale.ts`)

`RemoteAccess` owns the funnel. The **backend** arms it (not the desktop shell)
because only the backend knows its own port — `main.ts` calls
`remoteAccess.onServerStarted(server.port)` right after `Bun.serve`. The
enabled flag lives in `app_settings` (`remote-access-settings.ts`, default
**off**); toggling off disarms (`tailscale funnel reset`) immediately.

The tailscale CLI is located with an augmented PATH probe
(`/opt/homebrew/bin`, `~/.local/bin`, the macOS
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` bundle CLI…) for the
same reason `acquireEnv` exists: GUI-launched apps inherit a minimal PATH.

A typed state machine drives the guided UI (`GET/POST /api/admin/remote-access`,
admin-only):

| state | meaning | UI action |
|---|---|---|
| `not-installed` | no tailscale CLI found | link to tailscale.com/download |
| `needs-login` | installed, logged out | "Sign in to Tailscale" (authUrl from `status --json` when present) |
| `needs-operator` | Linux: serve/funnel config is root-only until the one-time operator grant | shows the exact `sudo tailscale set --operator=<user>` command + Copy + Retry |
| `funnel-not-enabled` | funnel node attribute unapproved | "Approve Funnel" (enable URL parsed from CLI stderr) |
| `inactive` | logged in, remote access off | — |
| `active` | funnel armed | shows the public URL |
| `error` | anything else | raw CLI detail surfaced |

### Linux: one-time operator setup (`needs-operator`)

On Linux, tailscaled's control socket is root-owned and it refuses serve/funnel
config changes from a non-root, non-operator user ("Access denied: serve config
denied … use 'sudo tailscale set --operator=$USER' once"). That single sudo is
unavoidable — it's tailscaled's own security policy — but it is genuinely
one-time: after it, NicotinD arms/disarms the funnel sudo-free forever.
`parseOperatorDenied` promotes this exact failure into the `needs-operator`
state; the server resolves the username itself (`os.userInfo().username` — the
user the backend, and hence the CLI, runs as) so the UI shows a copy-pasteable
one-liner plus a **Retry** that re-arms (`setEnabled(true)` is idempotent)
without toggling Off/On. macOS's GUI Tailscale runs per-user and doesn't hit
this. Possible future auto-fix: a desktop-only `pkexec` (polkit) prompt that
runs the grant for the user.

Parsers (`parseTailscaleStatus`, `parseFunnelEnableUrl`) are pure and
version-tolerant — CLI output drift degrades to `error {detail}`, never a
crash. The funnel public URL is *derived from the MagicDNS name*
(`https://<Self.DNSName>`), not parsed from funnel output, because the DNS name
is the stable part. Each boot re-arms with the current (possibly ephemeral)
port; the public URL never changes.

Docker note: the tailscale CLI usually lives on the *host*, not in the
container, so the panel shows `not-installed` there — pairing still works via
the request-origin candidate (below).

## Pairing flow

1. **Mint** — `POST /api/devices/pair` (auth): a 32-byte base64url token
   (256-bit) + a 6-char human code (alphabet `A-Z2-9` minus `0/O/1/I` —
   ~1.07e9 combos), TTL **5 minutes**, single-use, one live token per user
   (reminting deletes the previous unclaimed one). Stored in `pairing_tokens`.
2. **QR** — the Devices page renders the payload with the `qrcode` package:

   ```json
   { "v": 1, "kind": "nicotind-pair", "name": "<hostname>",
     "urls": ["https://desk.tail1234.ts.net", "https://music.example.com"],
     "token": "…" }
   ```

   `urls` comes from `candidateUrls()` (`services/pairing-urls.ts`): funnel URL
   first, then the **request origin** (what the admin's browser reached the
   server on — covers reverse-proxied/Docker deployments with no Tailscale);
   loopback origins are filtered (the desktop renderer hits `127.0.0.1`, which
   no phone can use). No usable URL → the page shows an "enable remote access"
   prompt instead of a dead QR. The manual fallback line (first URL + code) is
   always shown when a URL exists.
3. **Scan** — the phone's server-picker gains a native-only **Scan QR** button
   (`@capacitor/barcode-scanner` via the `Capacitor.Plugins` global —
   `scanBarcode()` in `services/native/native-capabilities.ts`, so `@capacitor/*`
   stays out of the web bundle; Electron/web return null and hide the button).
   `lib/pairing.ts` parses the payload (foreign QR content fails soft), probes
   the candidates in order against `/api/health`, and claims against the first
   one that answers. A **pairing code** field next to the URL input is the
   manual path: URL + code typed from the server's screen.
4. **Claim** — `POST /api/devices/claim` (public, `{ token? | code?, deviceName?,
   platform? }`): single-use check (410 expired/claimed, 404 unknown), then
   mints a **normal 30-day sliding JWT** for the minting user with a `deviceId`
   claim, and inserts a `paired_devices` row. The phone stores the JWT through
   the standard `AuthService.login` path — from here on it's an ordinary
   session. An unauthenticated claim endpoint is OK for the same reason
   `share/activate` is: the token *is* the credential, minted seconds earlier
   by a logged-in user.

### Rate limiting (claim)

In-process fixed windows (`createFixedWindowLimiter`): ~30 claim attempts/min
globally plus a stricter **10 failures / 5 min** budget → 429. Against the
6-char code space and 5-minute TTL this makes brute force non-viable without
per-IP plumbing (it's a home server). There is no persistent lockout — the
window just passes.

## Device registry + revocation

`paired_devices` (id, user_id, name, platform, created_at, last_seen_at).
**Row deletion is the revoked state** — deliberately minimal, matching the
no-sessions-table design. Enforcement is at `POST /api/auth/refresh`: a JWT
carrying a `deviceId` whose row is gone gets 403 "Device revoked" (and the
row's `last_seen_at` is bumped on every successful refresh; `deviceId` is
threaded into the re-signed token). So **revocation takes effect at the
device's next refresh** (app boot), not instantly — a deliberate trade-off.
Optional hardening if ever needed: fold a `paired_devices` existence check into
`authMiddleware`'s existing per-request user-status query for instant kill.

The Devices page (`/settings/devices`, user-gated — devices belong to the
signed-in user; only the remote-access panel is admin-gated) lists devices with
platform / linked / last-seen and a Revoke button.

## Security summary

- 256-bit single-use token, 5-min TTL, one-per-user, invalidated on remint.
- Code brute force bounded by TTL + failure limiter (429).
- Funnel exposes **only** HTTPS/443 to the public internet; the backend never
  binds a public interface. Login/JWT is the gate — docs and UI copy advise a
  strong password. Remote access is **off by default**.
- The QR payload contains no secrets beyond the 5-minute token; a stale
  screenshot of the QR is useless after expiry/claim.

## Tests

- API: `routes/devices.test.ts` (mint/claim/single-use/expiry/rate-limit/
  revoke/ownership), `routes/auth.test.ts` (refresh: revoked-device 403,
  deviceId passthrough + last_seen bump), `services/pairing-urls.test.ts`
  (candidates + tailscale parsers).
- Web: `lib/pairing.spec.ts` (payload round-trip, foreign-QR rejection, probe
  order, claim errors), `services/api/devices-api.service.spec.ts`.
- e2e: `tests/device-pairing.spec.ts` — mints on the real server, claims by
  code via direct fetch (no camera in CI), asserts the device row, revoke, and
  the 403 refresh; also asserts the CI-degraded (no tailscale) guidance renders.
