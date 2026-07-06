# Onboarding

NicotinD serves two distinct user types, each with a tailored first-run experience.

---

## Two user types

### Self-hosters (first-time installers)
Run `nicotind` on their own hardware. The first admin account is open to anyone (no invite required). After setup, subsequent user accounts must be created by an admin via the Admin panel.

### App users (credential recipients)
Receive a username/password from their self-hoster admin. Log in and use the shared library immediately — no setup required.

---

## Self-hoster: Setup Wizard

The setup wizard at `/setup` runs when no users exist in the database. It guides through 4 required steps plus an optional advanced panel:

| Step | Name | What it configures |
|------|------|--------------------|
| 1 | Admin Account | Admin username + password |
| 2 | Library | Music directory (auto-defaults to `~/Music`) |
| 3 | Quality | Lossless → Opus conversion toggle + bitrate (128/192/256 kbps) |
| 4 | Soulseek | Optional Soulseek credentials |
| — | Advanced Services (collapsed) | Lidarr URL + API key for metadata enrichment |

**Backend endpoint:** `POST /api/setup/complete`

```json
{
  "admin": { "username": "...", "password": "..." },
  "soulseek": { "username": "...", "password": "..." },
  "musicDir": "/mnt/music",
  "transcodeLossless": { "enabled": true, "bitrate": 192 },
  "lidarr": { "url": "http://localhost:8686", "apiKey": "..." }
}
```

- `musicDir` updates `config.musicDir` and persists to `app_settings`
- `transcodeLossless` writes to the `streaming` key in `app_settings`
- `lidarr` writes to `config.lidarr`, saves the API key to `secrets.json`, and — if Lidarr was already running — restarts it; in external mode, calls `PUT /api/v1/config` on the Lidarr instance
- Returns `{ token, user, needsRestart }` — `needsRestart: true` when Lidarr was configured, so the UI can show *"Lidarr will be available after restarting NicotinD"*

### API reference

**`GET /api/setup/status`** → `{ needsSetup: boolean }`

**`POST /api/setup/complete`** → `201 { token, user, needsRestart }` | `400` if already set up

### E2E coverage

Because the wizard only renders at `needsSetup: true` (zero users) and completing it
creates the first admin (a one-shot per server), `tests/onboarding.spec.ts` runs in a
dedicated `onboarding` Playwright project against a **second, never-seeded server**
(port 8586, own DB) — separate from the seeded main suite. See [e2e.md](e2e.md).

---

## App users: First-Login Welcome Banner

When an admin-provisioned user (`role: 'user'`) logs in for the first time, a dismissable banner appears at the top of the layout:

> *Welcome! Your admin has set up your account. Browse the library, search Soulseek, or start playing music.*

Clicking **Got it** calls `POST /api/auth/dismiss-welcome` which sets `welcome_dismissed = 1` in `user_settings`. The banner never reappears after dismissal.

### API reference

**`POST /api/auth/dismiss-welcome`** — requires auth, sets `welcomeDismissed = 1`

**`GET /api/auth/me`** — returns the current user profile including `welcomeDismissed: boolean`

---

## Registration policy

- First admin: always open via `/api/setup/complete` or `/api/auth/register`
- Subsequent users: admin-only via `POST /api/admin/users` (or `registrationEnabled: true` in config enables self-registration for all)

The existing Admin panel at `/admin` provides user management (list, create, reset password, disable, delete) without requiring API calls.
