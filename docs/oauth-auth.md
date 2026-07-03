# OAuth Authentication (Google & Microsoft)

> Status: **Planned — not yet implemented.** This document is the full design spec.

## Overview

Add Google and Microsoft OAuth login to NicotinD as an **`auth` plugin kind** with an
`oauth` capability. A dev bypass provider is included for local development. The
developer fills env variables, enables the plugin(s) in Settings, and the login page
auto-adapts.

Email validation is skipped — the email from the OAuth provider is trusted directly.

## Architecture

```
Login Page                    Backend                     Provider
   |                            |                            |
   |-- GET /api/auth/providers->|                            |
   |<-- [{id,name,enabled}] ---|                            |
   |                            |                            |
   |-- [Sign in with Google] --|-- GET /api/auth/oauth/google->|
   |<-- 302 redirect ----------|<-- authorization URL --------|
   |                            |                            |
   |---- browser redirect to provider consent screen ------->|
   |                            |                            |
   |<-- callback with code -----|<-- redirect back ---------|
   |                            |                            |
   |-- GET /api/auth/callback/google?code=...&state=... --->|
   |                            |-- exchange code for token ->|
   |                            |<-- {email, name} ----------|
   |                            |-- find/create user by email|
   |                            |-- sign JWT                 |
   |<-- redirect to / with token in URL fragment ------------|
   |                            |                            |
   |-- [Dev Login] (dev bypass only) ----------------------->|
   |-- POST /api/auth/dev-login {email} ------------------->|
   |<-- {token, user} --------------------------------------|
```

### Key design decisions

1. **New plugin kind `auth`** with capability `oauth` — keeps OAuth providers modular,
   opt-in, and manageable through the existing Settings → Plugins UI.
2. **Dev bypass is not a plugin** — it's a built-in route gated by `OAUTH_DEV_BYPASS=true`
   env var. Shows a mock "Dev Login" button on the login page that accepts any email.
3. **Auto-create users on first OAuth login** — linked by email. First-ever user still
   gets admin role (same as password registration).
4. **Password hash is empty string** for OAuth-only users — they cannot use password login.
5. **CSRF protection** via `state` parameter stored in DB, single-use, 10-min expiry.
6. **Token delivered in URL fragment** (`#token=...`) on callback redirect — never
   logged in server access logs.

## Phase 1: Core Plugin System — Add `auth` Kind

### `packages/core/src/plugin/manifest.ts`

- Add `'auth'` to `PluginKind` union: `'acquisition' | 'metadata' | 'connectivity' | 'auth'`
- Add `'oauth'` to capability name types
- Update `validatePluginManifest()` — `auth` kind uses its own capability set;
  `auth` plugins are always opt-in (`defaultEnabled: false`, same as acquisition)

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
  getAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthUserInfo>;
}
```

### `packages/core/src/plugin/index.ts`

Export `OAuthCapability` and `OAuthUserInfo`.

## Phase 2: OAuth Provider Plugins

### `packages/api/src/services/plugins/oauth-google/index.ts`

- Manifest: `id: 'oauth-google'`, `kind: 'auth'`, `capabilities: ['oauth']`,
  `defaultEnabled: false`
- Config schema: `{ clientId: string, clientSecret: string }`
- Config fields: two `text` fields (client ID is text, client secret is password)
- `getAuthorizationUrl(state)`:
  - `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&response_type=code&scope=openid+email+profile&state=...&access_type=offline`
- `exchangeCode(code)`:
  - POST `https://oauth2.googleapis.com/token` with `authorization_code` grant
  - GET `https://www.googleapis.com/oauth2/v2/userinfo` with access token
  - Return `{ email, name, providerId: 'google', providerUserId }`

### `packages/api/src/services/plugins/oauth-microsoft/index.ts`

- Manifest: `id: 'oauth-microsoft'`, `kind: 'auth'`, `capabilities: ['oauth']`,
  `defaultEnabled: false`
- Config schema: `{ clientId: string, clientSecret: string }`
- `getAuthorizationUrl(state)`:
  - `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=...&redirect_uri=...&response_type=code&scope=openid+email+profile&state=...`
- `exchangeCode(code)`:
  - POST `https://login.microsoftonline.com/common/oauth2/v2.0/token` with `authorization_code` grant
  - GET `https://graph.microsoft.com/v1.0/me` with access token
  - Return `{ email, name, providerId: 'microsoft', providerUserId }`

## Phase 3: Database Schema Changes

### `packages/api/src/db.ts` — additions to `applySchema`

```sql
-- OAuth provider linkage on users (safe ALTER TABLE, wrapped in try/catch)
ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN email TEXT;

-- OAuth state tokens for CSRF protection
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

Add index on `users(email)` for lookup speed.

## Phase 4: Backend OAuth Routes

### New file: `packages/api/src/routes/oauth.ts`

| Route | Method | Auth? | Purpose |
|-------|--------|-------|---------|
| `/api/auth/providers` | GET | Public | List available OAuth providers (enabled auth plugins) |
| `/api/auth/oauth/:provider` | GET | Public | Start OAuth flow — returns `{ url }` for redirect |
| `/api/auth/callback/:provider` | GET | Public | Callback — exchange code, find/create user, redirect |
| `/api/auth/dev-login` | POST | Public | Dev bypass — `{ email }` → user + JWT |

### New file: `packages/api/src/services/oauth.ts`

User lookup/create helper:

- Find user by `email` + `provider`
- If not found: create with `id = crypto.randomUUID()`, `username = email` (deduped),
  `password_hash = ''`, `role` = admin if first user, else `'user'`, `provider`, `email`
- If found: return existing user

### Callback redirect

Redirect to `http://localhost:{port}/auth/callback#token=...&user=...`. The frontend
`AuthCallbackComponent` parses the hash and calls `auth.login()`.

### State management

- Generate `state = crypto.randomUUID()`, store in `oauth_states` with 10-min expiry
- On callback: validate state exists and hasn't expired, then delete it
- Lazy GC: delete expired states on each callback

## Phase 5: Dev Bypass Provider

Not a plugin — a built-in route gated by `OAUTH_DEV_BYPASS=true`.

- `POST /api/auth/dev-login` accepts `{ email: string }`
- Creates/returns user with `provider = 'dev'`, `email = <provided>`
- `GET /api/auth/providers` includes `{ id: 'dev', name: 'Dev Login', devOnly: true }`
  when bypass is enabled
- Login page shows a distinct "Dev Login" button

## Phase 6: Config & Env Variables

### `packages/core/src/types/config.ts` — add to `NicotinDConfigSchema`

```typescript
oauth: z.object({
  devBypass: z.boolean().default(false),
  google: z.object({
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
  }).default({ clientId: '', clientSecret: '' }),
  microsoft: z.object({
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
  }).default({ clientId: '', clientSecret: '' }),
}).default({ ... })
```

### `src/main.ts` — env var mappings

| Env Var | Config Path | Type |
|---------|-------------|------|
| `OAUTH_DEV_BYPASS` | `oauth.devBypass` | `parseBooleanEnv()` |
| `OAUTH_GOOGLE_CLIENT_ID` | `oauth.google.clientId` | string |
| `OAUTH_GOOGLE_CLIENT_SECRET` | `oauth.google.clientSecret` | string |
| `OAUTH_MICROSOFT_CLIENT_ID` | `oauth.microsoft.clientId` | string |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | `oauth.microsoft.clientSecret` | string |

### `.env.example` — add section

```env
# ── OAuth (Google & Microsoft) ──────────────────────────────
# Set OAUTH_DEV_BYPASS=true for local development (mock login, no real provider).
# For production, register apps at Google Cloud Console / Azure Portal and fill below.
OAUTH_DEV_BYPASS=true
OAUTH_GOOGLE_CLIENT_ID=
OAUTH_GOOGLE_CLIENT_SECRET=
OAUTH_MICROSOFT_CLIENT_ID=
OAUTH_MICROSOFT_CLIENT_SECRET=
```

## Phase 7: Plugin Registration & Wiring

### `packages/api/src/index.ts`

```typescript
// Auth plugins (opt-in)
plugins.register(new GoogleOAuthPlugin(config.oauth.google));
plugins.register(new MicrosoftOAuthPlugin(config.oauth.microsoft));

// OAuth routes (public, always mounted)
app.route('/api/auth', oauthRoutes({
  plugins,
  jwtSecret: config.jwt.secret,
  jwtExpiresIn: config.jwt.expiresIn,
  devBypass: config.oauth.devBypass,
  baseUrl: `http://localhost:${config.port}`,
}));
```

OAuth routes use `plugins.getEnabledWithCapability('oauth')` to discover active providers.

## Phase 8: Frontend Changes

### Modified files

| File | Change |
|------|--------|
| `services/api/auth-api.service.ts` | Add `getProviders()`, `startOAuth(provider)`, `devLogin(email)` |
| `services/api/api-types.ts` | Add `OAuthProvider`, `OAuthStartResult` types |
| `pages/login/login.component.ts` | Load providers, render OAuth buttons, handle dev login |
| `pages/login/login.component.html` | Add OAuth buttons section + dev login form |
| `app.routes.ts` | Add `/auth/callback` route |

### New files

- `pages/auth-callback/auth-callback.component.ts` — parses `window.location.hash` for
  `#token=...&user=...`, calls `auth.login()`, navigates to `/`
- `pages/auth-callback/auth-callback.component.html` — loading spinner + error state

### Login page layout

```
┌─────────────────────────────────┐
│         NicotinD                │
│    Sign in to continue          │
│                                 │
│  [Sign in with Google]          │
│  [Sign in with Microsoft]       │
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

## Phase 9: Testing

| Test | Location |
|------|----------|
| Plugin manifest validation for `auth` kind | `packages/core/src/plugin/manifest.test.ts` |
| Google OAuth plugin (mock fetch) | `packages/api/src/services/plugins/oauth-google/index.test.ts` |
| Microsoft OAuth plugin (mock fetch) | `packages/api/src/services/plugins/oauth-microsoft/index.test.ts` |
| OAuth routes (dev bypass + callback flow) | `packages/api/src/routes/oauth.test.ts` |
| Frontend auth-callback component | `packages/web/src/app/pages/auth-callback/auth-callback.component.spec.ts` |
| E2E: dev login flow | `packages/e2e/tests/auth.spec.ts` |

## Phase 10: Documentation

- `docs/design-patterns.md` — add OAuth entry
- `docs/plugins.md` — document `auth` kind
- `CLAUDE.md` — add OAuth plugin bullet in Key Design Patterns

## File Inventory

### New files (8)

| File | Purpose |
|------|---------|
| `packages/api/src/services/plugins/oauth-google/index.ts` | Google OAuth plugin |
| `packages/api/src/services/plugins/oauth-microsoft/index.ts` | Microsoft OAuth plugin |
| `packages/api/src/routes/oauth.ts` | OAuth + dev-login routes |
| `packages/api/src/services/oauth.ts` | User lookup/create helper |
| `packages/web/src/app/pages/auth-callback/auth-callback.component.ts` | Callback page |
| `packages/web/src/app/pages/auth-callback/auth-callback.component.html` | Callback template |
| `packages/api/src/services/plugins/oauth-google/index.test.ts` | Google plugin tests |
| `packages/api/src/services/plugins/oauth-microsoft/index.test.ts` | Microsoft plugin tests |

### Modified files (14)

| File | Change |
|------|--------|
| `packages/core/src/plugin/manifest.ts` | Add `auth` kind + `oauth` capability |
| `packages/core/src/plugin/capabilities.ts` | Add `OAuthCapability` interface |
| `packages/core/src/plugin/index.ts` | Export new types |
| `packages/core/src/types/config.ts` | Add `oauth` config block |
| `packages/api/src/db.ts` | `provider`/`email` columns + `oauth_states` table |
| `packages/api/src/index.ts` | Register auth plugins, mount OAuth routes |
| `src/main.ts` | Env var mappings for OAuth config |
| `.env.example` | OAuth env vars section |
| `packages/web/src/app/services/api/auth-api.service.ts` | OAuth HTTP methods |
| `packages/web/src/app/services/api/api-types.ts` | OAuth types |
| `packages/web/src/app/pages/login/login.component.ts` | OAuth button logic |
| `packages/web/src/app/pages/login/login.component.html` | OAuth button UI |
| `packages/web/src/app/app.routes.ts` | `/auth/callback` route |
| `packages/api/src/routes/oauth.test.ts` | Route tests |

## Security Considerations

1. **CSRF protection** — `state` parameter in OAuth flow, stored in DB, single-use, 10-min expiry
2. **No email validation** (per requirement) — email comes from verified provider exchange
3. **Password hash is empty string** for OAuth-only users — cannot use password login
4. **Dev bypass gated by env var** — production never sets `OAUTH_DEV_BYPASS=true`
5. **Client secrets in plugin config** — same pattern as Spotify plugin, never exposed to frontend
6. **Token in URL fragment** — `#token=...` not logged in server access logs
7. **Plugin config masking** — `clientSecret` uses `type: 'password'` config field, never
   returned to the UI (write-only, same as other secret fields)
