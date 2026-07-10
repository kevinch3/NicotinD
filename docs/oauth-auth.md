# OAuth Authentication (Google & Microsoft)

> Status: **Proposed — not yet implemented.** This document is the full design
> spec the implementation will follow. None of the code, routes, env vars,
> plugins, or mobile deep-links described here exist yet.

## Overview

Add Google and Microsoft OAuth login to NicotinD as an **`auth` plugin kind**
with an `oauth` capability. A **dev bypass** provider is included for local
development. The developer fills env variables, and the Google/Microsoft plugins
**auto-enable on first boot** when their creds are present — no Settings
interaction required for the login buttons to appear. A new
`NICOTIND_PUBLIC_URL` env var supplies the redirect base for production behind a
reverse proxy.

Email validation is skipped — the email from the OAuth provider is trusted
directly. Users are auto-created by email on first OAuth login; the first-ever
user becomes admin (same rule as password registration).

## Architecture

```
Login Page                    Backend                     Provider
   |                            |                            |
   |-- GET /api/auth/providers->|                            |
   |<-- [{id,name,enabled}] ---|                            |
   |                            |                            |
   |-- [Sign in with Google] --|-- GET /api/auth/oauth/google?client=web ->|
   |<-- {url} -----------------|<-- authorization URL -------|
   |---- browser redirect to provider consent screen ------->|
   |                            |                            |
   |<-- callback with code -----|<-- redirect back ---------|
   |-- GET /api/auth/callback/google?code=...&state=... --->|
   |                            |-- exchange code for token ->|
   |                            |<-- {email, name} ----------|
   |                            |-- find/create user by email|
   |                            |-- sign JWT                 |
   |<-- 302 redirect to /auth/callback#token=...&user=... --|
   |                            |                            |
   |-- [Dev Login] (dev bypass only) ----------------------->|
   |-- POST /api/auth/dev-login {email} ------------------->|
   |<-- {token, user} --------------------------------------|
```

### Mobile (Capacitor) flow

The native app and the web served UI share the **same server callback** — the
provider redirects back to `${NICOTIND_PUBLIC_URL}/api/auth/callback/:provider`
in both cases. The difference is the **final hop**: the server inspects
`state.client` (`'web'` or `'mobile'`, recorded when the flow started) and:

- **web**: 302 → `/auth/callback#token=…` (SPA route parses the hash).
- **mobile**: 302 → `nicotind://auth-callback#token=…&provider=…` (a
  custom-scheme deep link the Capacitor app receives via
  `@capacitor/app`'s `appUrlOpen` listener).

The mobile login button opens the provider consent screen in the system browser
(`@capacitor/browser`), not the WebView, so the user authenticates with their
real Google/Microsoft session. After consent, the system browser → server
callback → `nicotind://` deep link → the app reads `#token=…` → calls
`AuthService.login()` → navigates to `/`.

### Key design decisions

1. **New plugin kind `auth`** with capability `oauth` — keeps OAuth providers
   modular, opt-in, and manageable through the existing Settings → Extensions
   UI.
2. **Auto-enable when creds are present** — `seedEnabled('oauth-google',
   'system')` runs on first boot when `OAUTH_GOOGLE_CLIENT_ID` + `SECRET` are
   non-empty (likewise Microsoft). Idempotent; an admin's later disable wins.
   Auth is not acquisition, so the plugin `defaultEnabled:false` ban (which is
   scoped to `acquisition` only) doesn't block this.
3. **`NICOTIND_PUBLIC_URL` is the redirect base** — the optional env var for
   the public https origin. Falls back to `http://localhost:${port}` when
   unset. The registered redirect URI for both providers is
   `${NICOTIND_PUBLIC_URL}/api/auth/callback/:provider` — a single string per
   provider works for web and mobile.
4. **Dev bypass is not a plugin** — a built-in route gated by
   `OAUTH_DEV_BYPASS=true`. Shows a mock "Dev Login" button on the login page
   that accepts any email. Default-on in `.env.example` so a fresh checkout
   works with zero provider setup; flip to false for production.
5. **Auto-create users on first OAuth login** — linked by `email` + `provider`.
   First-ever user still gets admin (same as password registration).
6. **Password hash is empty string** for OAuth-only users — they cannot use
   password login.
7. **CSRF protection** via `state` parameter stored in `oauth_states` table,
   single-use, 10-min expiry.
8. **Token delivered in URL fragment** (`#token=…`) on callback redirect — never
   logged in server access logs, works across the WebView/native boundary.

## Phase 1: Core Plugin System — Add `auth` Kind

### `packages/core/src/plugin/manifest.ts`

- Add `'auth'` to `PluginKind` union: `'acquisition' | 'metadata' | 'connectivity' | 'auth'`
- Add `AuthCapabilityName = 'oauth'`; fold into `PluginCapability`
- Update `validatePluginManifest()` — `auth` kind allows only the `oauth`
  capability; the `defaultEnabled:false` ban stays scoped to `acquisition`
  only (auth plugins may seed-enable, but manifests stay
  `defaultEnabled:false`)

### `packages/core/src/plugin/capabilities.ts`

Add `OAuthCapability`:

```typescript
export interface OAuthUserInfo {
  email: string;
  name?: string;
  providerId: string;
  providerUserId: string;
}

export interface OAuthCapability {
  readonly providerId: string;
  readonly providerName: string;
  /** Build the provider authorization URL. `redirectUri` is dynamic
   *  (derived from NICOTIND_PUBLIC_URL / fallback) so one plugin serves
   *  dev, prod, and mobile. */
  getAuthorizationUrl(state: string, redirectUri: string): string;
  /** Exchange the auth code for a user identity. */
  exchangeCode(code: string, redirectUri: string): Promise<OAuthUserInfo>;
}
```

### `packages/core/src/plugin/index.ts`

Export `OAuthCapability`, `OAuthUserInfo`, `AuthCapabilityName`. Add
`readonly oauth?: OAuthCapability;` to the `Plugin` interface.

## Phase 2: OAuth Provider Plugins

### `packages/api/src/services/plugins/oauth-google/index.ts`

- Manifest: `id: 'oauth-google'`, `kind: 'auth'`, `capabilities: ['oauth']`,
  `defaultEnabled: false`, no binaries, no consent
- Config schema: `{ clientId: string, clientSecret: string }`
- Config fields: `clientId` (`text`), `clientSecret` (`password` — write-only,
  never returned to the UI, same masking pattern as the Spotify plugin)
- `getAuthorizationUrl(state, redirectUri)`:
  - `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=…&response_type=code&scope=openid+email+profile&state=…&access_type=offline`
- `exchangeCode(code, redirectUri)`:
  - POST `https://oauth2.googleapis.com/token` with `authorization_code` grant
  - GET `https://www.googleapis.com/oauth2/v2/userinfo` with access token
  - Return `{ email, name, providerId: 'google', providerUserId }`
- `isAvailable()` = enabled && both creds set
- Injectable `fetchFn` so tests run without network

### `packages/api/src/services/plugins/oauth-microsoft/index.ts`

- Manifest: `id: 'oauth-microsoft'`, `kind: 'auth'`, `capabilities: ['oauth']`,
  `defaultEnabled: false`, no binaries, no consent
- Config schema: `{ clientId: string, clientSecret: string }`
- Config fields: `clientId` (`text`), `clientSecret` (`password`)
- `getAuthorizationUrl(state, redirectUri)`:
  - `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=…&redirect_uri=…&response_type=code&scope=openid+email+profile&state=…`
- `exchangeCode(code, redirectUri)`:
  - POST `https://login.microsoftonline.com/common/oauth2/v2.0/token` with
    `authorization_code` grant
  - GET `https://graph.microsoft.com/v1.0/me` with access token
  - Return `{ email, name, providerId: 'microsoft', providerUserId }`

## Phase 3: Database Schema Changes

### `packages/api/src/db.ts` — additions to `applySchema`

```sql
-- OAuth provider linkage on users (safe ALTER TABLE, wrapped in try/catch)
ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN email TEXT;

-- OAuth state tokens for CSRF protection. client_kind drives the final
-- redirect target: 'web' → /auth/callback#token, 'mobile' → nicotind://…
CREATE TABLE IF NOT EXISTS oauth_states (
  state        TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  client_kind  TEXT NOT NULL DEFAULT 'web',  -- 'web' | 'mobile'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

## Phase 4: Backend OAuth Routes

### New file: `packages/api/src/routes/oauth.ts`

Mounted public (no JWT) at `/api/auth` alongside the existing `authRoutes`.

| Route | Method | Auth? | Purpose |
|-------|--------|-------|---------|
| `/api/auth/providers` | GET | Public | List enabled `oauth`-capability plugins + `dev` when `devBypass` |
| `/api/auth/oauth/:provider?client=web\|mobile` | GET | Public | Start OAuth flow — mint `state`, store in `oauth_states` (10-min expiry), build `redirect_uri` from `publicUrl`/fallback, return `{ url }` |
| `/api/auth/callback/:provider?code=&state=` | GET | Public | Validate+delete `state` (lazy GC expired), `exchangeCode`, find/create user, sign JWT, 302 to web `/auth/callback#token=…` or mobile `nicotind://auth-callback#token=…` |
| `/api/auth/dev-login` | POST | Public | Dev bypass — `{ email }` → user + JWT JSON (no redirect) |

State validation failures and unknown providers throw typed
`NicotinDError`s (mapped by the central `errorHandler`) — consistent with
the throw-typed-errors pattern.

### New file: `packages/api/src/services/oauth.ts`

User lookup/create helper:

- Find user by `email` + `provider`
- If not found: create with `id = crypto.randomUUID()`, `username = email`
  (deduped suffix if collision), `password_hash = ''`, `role = admin` if first
  user else `'user'`, `provider`, `email`
- If found: return existing user
- Insert a `user_settings` row too (mirrors `routes/auth.ts` register path)

### Redirect URI construction

```
const base = publicUrl || `http://localhost:${port}`;
const redirectUri = `${base}/api/auth/callback/${provider}`;
```

The same `redirectUri` is passed to both `getAuthorizationUrl` and
`exchangeCode` (Google/Azure require an exact match between the authorize and
token requests). One registered redirect URI per provider covers both web and
mobile because mobile uses the **same server callback** — only the final 302
target differs.

### State management

- Generate `state = crypto.randomUUID()`, store in `oauth_states` with
  `client_kind` (from the `?client=` param) and 10-min expiry
- On callback: validate state exists and hasn't expired, then delete it
  (single-use)
- Lazy GC: delete expired states on each callback

## Phase 5: Dev Bypass Provider

Not a plugin — a built-in route gated by `OAUTH_DEV_BYPASS=true`.

- `POST /api/auth/dev-login` accepts `{ email: string }` — only when
  `devBypass` is on; returns 403 otherwise
- Creates/returns user with `provider = 'dev'`, `email = <provided>`
- `GET /api/auth/providers` includes `{ id: 'dev', name: 'Dev Login',
  devOnly: true }` when bypass is enabled
- Login page shows a distinct "Dev Login" button with an email-only input

## Phase 6: Config & Env Variables

### `packages/core/src/types/config.ts` — add to `NicotinDConfigSchema`

```typescript
oauth: z.object({
  devBypass: z.boolean().default(false),
  publicUrl: z.string().default(''),   // falls back to http://localhost:${port}
  google: z.object({
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
  }).default({ clientId: '', clientSecret: '' }),
  microsoft: z.object({
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
  }).default({ clientId: '', clientSecret: '' }),
}).default({ devBypass: false, publicUrl: '', google: { … }, microsoft: { … } })
```

### `src/main.ts` — env var mappings

| Env Var | Config Path | Type |
|---------|-------------|------|
| `OAUTH_DEV_BYPASS` | `oauth.devBypass` | `parseBooleanEnv()` |
| `NICOTIND_PUBLIC_URL` | `oauth.publicUrl` | string |
| `OAUTH_GOOGLE_CLIENT_ID` | `oauth.google.clientId` | string |
| `OAUTH_GOOGLE_CLIENT_SECRET` | `oauth.google.clientSecret` | string |
| `OAUTH_MICROSOFT_CLIENT_ID` | `oauth.microsoft.clientId` | string |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | `oauth.microsoft.clientSecret` | string |

### `.env.example` — add section

```env
# ── OAuth (Google & Microsoft) ─────────────────────────────────
# Local dev with no provider: set OAUTH_DEV_BYPASS=true for a mock "Dev Login".
# Production: register a Web Application at Google Cloud Console / Azure Portal,
# set NICOTIND_PUBLIC_URL to your public https origin, and fill the client creds.
# The registered redirect URI for BOTH providers is:
#   ${NICOTIND_PUBLIC_URL}/api/auth/callback/google   (and /oauth-microsoft)
# Mobile uses the same server callback; NicotinD then deep-links the token back
# into the app via the nicotind:// scheme (already wired, no app config needed).
OAUTH_DEV_BYPASS=true
NICOTIND_PUBLIC_URL=
OAUTH_GOOGLE_CLIENT_ID=
OAUTH_GOOGLE_CLIENT_SECRET=
OAUTH_MICROSOFT_CLIENT_ID=
OAUTH_MICROSOFT_CLIENT_SECRET=
```

`OAUTH_DEV_BYPASS=true` is the default in `.env.example` so a fresh checkout
works with zero provider setup. Flip to false (or unset) for production.

### `config/default.yml` — add `oauth` block

```yaml
oauth:
  devBypass: false
  publicUrl: ''
  google:
    clientId: ''
    clientSecret: ''
  microsoft:
    clientId: ''
    clientSecret: ''
```

## Phase 7: Plugin Registration & Wiring

### `packages/api/src/index.ts`

```typescript
// Auth plugins (opt-in, but auto-seed-enable when creds are present).
plugins.register(new GoogleOAuthPlugin(config.oauth.google));
plugins.register(new MicrosoftOAuthPlugin(config.oauth.microsoft));

// Auto-enable when creds are present (idempotent; admin can disable later).
if (config.oauth.google.clientId && config.oauth.google.clientSecret)
  plugins.seedEnabled('oauth-google', 'system');
if (config.oauth.microsoft.clientId && config.oauth.microsoft.clientSecret)
  plugins.seedEnabled('oauth-microsoft', 'system');

// OAuth routes (public, always mounted — self-gate on devBypass + enabled plugins)
app.route('/api/auth', oauthRoutes({
  plugins,
  jwtSecret: config.jwt.secret,
  jwtExpiresIn: config.jwt.expiresIn,
  devBypass: config.oauth.devBypass,
  publicUrl: config.oauth.publicUrl,
  fallbackBase: `http://localhost:${config.port}`,
}));
```

OAuth routes use `plugins.getEnabledWithCapability('oauth')` to discover active
providers. No auth middleware on `/api/auth/oauth`, `/api/auth/callback`, or
`/api/auth/dev-login` — they sit under the public `/api/auth` mount (existing
`/register`, `/login` are public too).

## Phase 8: Frontend — Web

### Modified files

| File | Change |
|------|--------|
| `services/api/auth-api.service.ts` | Add `getProviders()`, `startOAuth(provider, client='web')` (GET → `{url}`), `devLogin(email)` |
| `services/api/api-types.ts` | Add `OAuthProvider`, `OAuthStartResult` types |
| `pages/login/login.component.ts` | `ngOnInit` loads providers; render OAuth buttons (provider brand colours) above a `── or ──` divider; handle dev login |
| `pages/login/login.component.html` | Add OAuth buttons section + dev login form; existing password form stays as fallback lane |
| `app.routes.ts` | Add `/auth/callback` lazy route (public, no guards) |

### New files

- `pages/auth-callback/auth-callback.component.ts` — parses
  `window.location.hash` for `#token=…&user=…`, calls `auth.login()`,
  navigates to `/` on success / shows error + link back to `/login`
- `pages/auth-callback/auth-callback.component.html` — loading spinner + error state

### Login page layout

```
┌─────────────────────────────────┐
│         NicotinD                │
│    Sign in to continue          │
│                                 │
│  [ Sign in with Google ]        │
│  [ Sign in with Microsoft ]     │
│                                 │
│  ── or ──                       │
│                                 │
│  Username: [________]           │
│  Password: [________]           │
│  [Sign In]                      │
│                                 │
│  Don't have an account? Register│
└─────────────────────────────────┘
```

When `devBypass=true`, the OAuth section includes a "Dev Login" button with an
email-only input.

### `services/plugin.service.ts` (web)

Add `'auth'` to the local `PluginKind` union and `'oauth'` to
`PluginCapability`; add an `auth` computed + an "Authentication" section to
`pages/plugins/plugins.component.ts` (grouping by kind, mirroring the
Connectivity section) so the admin can see/toggle the OAuth plugins' config
fields. (The `metadata` kind is also missing from the web types — minor
correction folded in.)

## Phase 9: Frontend — Mobile (Capacitor)

Full cross-platform parity: the native app uses the **same server callback** as
web, but the final redirect targets a `nicotind://` deep link instead of the
SPA route.

### Dependencies

Add to `packages/mobile/package.json`:
- `@capacitor/app` — `appUrlOpen` listener to receive the deep link
- `@capacitor/browser` — opens the provider consent screen in the system
  browser (not the WebView, so the user authenticates with their real
  Google/Microsoft session)

### Deep-link registration

- **`capacitor.config.ts`**: register the `nicotind` custom scheme (for the
  OAuth handoff via `appUrlOpen`; the WebView stays on `https`/`capacitor://`
  as-is).
- **Android `AndroidManifest.xml`**: add an intent-filter for
  `nicotind://auth-callback` (config edit, not code).
- **iOS `Info.plist`**: add `CFBundleURLTypes` for the `nicotind` scheme
  (injected by the existing `scripts/ios-plist.ts` since `ios/` is ephemeral).

### Web-side handling (`packages/web/src/app/`)

- **New `services/oauth-mobile.service.ts`**: detect Capacitor native
  (`Capacitor.isNativePlatform()`); the OAuth button → `Browser.open({url})`
  instead of `window.location.href`; register a one-time
  `App.addListener('appUrlOpen', …)` that parses
  `nicotind://auth-callback#token=…`, calls `AuthService.login()`, and
  navigates to `/`. The token-handling logic is shared with the web
  `/auth/callback` handler.
- The login component branches: native → mobile service; web →
  `window.location.href = url`.

No new native plugin is required — `@capacitor/app` and
`@capacitor/browser` are official Capacitor 6 packages already pinned.

## Phase 10: Testing

| Test | Location |
|------|----------|
| Plugin manifest validation for `auth` kind + `oauth` capability | `packages/core/src/plugin/manifest.test.ts` |
| Google OAuth plugin (mock `fetchFn`, no network) | `packages/api/src/services/plugins/oauth-google/index.test.ts` |
| Microsoft OAuth plugin (mock `fetchFn`, no network) | `packages/api/src/services/plugins/oauth-microsoft/index.test.ts` |
| OAuth routes: providers list, dev-login + disabled-when-off, state validation (missing/expired/consumed), web vs mobile redirect target, user auto-create incl. first-user=admin, password-hash empty | `packages/api/src/routes/oauth.test.ts` |
| Frontend auth-callback component (hash parse → login nav) | `packages/web/src/app/pages/auth-callback/auth-callback.component.spec.ts` |
| E2E: dev login flow lights up `/auth/providers` + lands in app | `packages/e2e/tests/auth.spec.ts` (extended) |

**CI coverage**: `ci.yml` already runs `bun test packages/api/src packages/core/src …`,
`bun run --filter @nicotind/web test`, and `bun run --filter @nicotind/e2e test` — every
new test above is auto-picked up by the existing globs. No workflow file edits needed.

## Phase 11: Documentation

- `docs/design-patterns.md` — add OAuth entry
- `docs/plugins.md` — document `auth` kind + `oauth` capability + provider plugins
- `docs/mobile-app.md` / `docs/ios-app.md` — OAuth deep-link section
- `CLAUDE.md` — update the OAuth plugin index bullet

## File Inventory

### New files (12)

| File | Purpose |
|------|---------|
| `packages/api/src/services/plugins/oauth-google/index.ts` | Google OAuth plugin |
| `packages/api/src/services/plugins/oauth-google/index.test.ts` | Google plugin tests |
| `packages/api/src/services/plugins/oauth-microsoft/index.ts` | Microsoft OAuth plugin |
| `packages/api/src/services/plugins/oauth-microsoft/index.test.ts` | Microsoft plugin tests |
| `packages/api/src/routes/oauth.ts` | OAuth + dev-login routes |
| `packages/api/src/routes/oauth.test.ts` | Route tests |
| `packages/api/src/services/oauth.ts` | User lookup/create helper |
| `packages/web/src/app/pages/auth-callback/auth-callback.component.ts` | Callback page |
| `packages/web/src/app/pages/auth-callback/auth-callback.component.html` | Callback template |
| `packages/web/src/app/pages/auth-callback/auth-callback.component.spec.ts` | Callback component test |
| `packages/web/src/app/services/oauth-mobile.service.ts` | Capacitor OAuth deep-link handler |
| `.env.example` (modified) | OAuth env vars section |

### Modified files (14)

| File | Change |
|------|---------|
| `packages/core/src/plugin/manifest.ts` | Add `auth` kind + `oauth` capability |
| `packages/core/src/plugin/capabilities.ts` | Add `OAuthCapability` interface |
| `packages/core/src/plugin/index.ts` | Export new types + `oauth` accessor on `Plugin` |
| `packages/core/src/types/config.ts` | Add `oauth` config block |
| `packages/api/src/db.ts` | `provider`/`email` columns + `oauth_states` table + email index |
| `packages/api/src/index.ts` | Register auth plugins, auto-seed-enable, mount OAuth routes |
| `src/main.ts` | Env var mappings for OAuth config |
| `.env.example` | OAuth env vars section |
| `config/default.yml` | `oauth` block |
| `packages/web/src/app/services/api/auth-api.service.ts` | OAuth HTTP methods |
| `packages/web/src/app/services/api/api-types.ts` | OAuth types |
| `packages/web/src/app/services/plugin.service.ts` | Add `auth` kind + `oauth` capability |
| `packages/web/src/app/pages/login/login.component.{ts,html}` | OAuth button UI + dev login |
| `packages/web/src/app/app.routes.ts` | `/auth/callback` route |
| `packages/mobile/capacitor.config.ts` | `nicotind` scheme registration |
| `packages/mobile/package.json` | `@capacitor/app`, `@capacitor/browser` deps |
| Android `AndroidManifest.xml` | `nicotind://auth-callback` intent-filter |
| iOS `Info.plist` (via `scripts/ios-plist.ts`) | `CFBundleURLTypes` for `nicotind` scheme |

## Security Considerations

1. **CSRF protection** — `state` parameter in OAuth flow, stored in
   `oauth_states`, single-use, 10-min expiry
2. **No email validation** (per requirement) — email comes from verified
   provider token exchange
3. **Password hash is empty string** for OAuth-only users — cannot use password
   login
4. **Dev bypass gated by env var** — production never sets
   `OAUTH_DEV_BYPASS=true`; `.env.example` defaults it true only for local-dev
   convenience
5. **Client secrets in plugin config** — same `password`-type config field
   pattern as the Spotify plugin, never exposed to the frontend (write-only)
6. **Token in URL fragment** — `#token=…` not logged in server access logs
7. **First-user-is-admin via OAuth** — matches the existing password
   registration rule. Admins should provision the first account via setup, or
   keep `registrationEnabled`/`OAUTH_DEV_BYPASS` gated on a fresh, publicly-
   exposed server to avoid a malicious party bootstrapping admin via OAuth.