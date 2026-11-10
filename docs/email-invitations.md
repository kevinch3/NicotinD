# Invitations, email delivery & password recovery

> **Status: increments 1 (link invites) and 2 (account security) shipped; 3–5 planned.** The plan below
> (2026-11-09) is the agreed shape, so each increment can be built, tested and merged
> on its own. Coordinate with [oauth-auth.md](oauth-auth.md) (also unbuilt): it too adds a
> user email and `NICOTIND_PUBLIC_URL`, and both must land on the *same* column and the
> *same* variable.
## The principle

**The invite link is the primitive; email is one delivery channel for it.** Many
self-hosters will never configure email (see "Mailgun reality" below), so every flow
must work with *copy link / QR* first, and email upgrades it. **And email is
provider-agnostic**: SMTP is the baseline, so Mailgun is a preset, not a dependency (see
"Provider-agnostic by design").

## Shipped: link invites (increment 1)

- **Data**: `invites` (sha256 `token_hash`, role, note, expiry, `max_uses` ≤ 25, `use_count`,
  `revoked_at`) and `invite_acceptances` (who joined through which invite), in `db.ts`.
  Logic lives in `services/invites.ts`: `createInvite`, `listInvites`, `rotateInviteToken`,
  `revokeInvite`, `inspectInvite`, `acceptInvite`, and the pure `inviteStatus` (revoked >
  used > expired > pending).
- **Routes** (`routes/invites.ts`), split by trust like radio polls:
  `inviteAdminRoutes` under `/api/admin/invites` (list, mint, new link, revoke; audited as
  `invite.create` / `invite.rotate` / `invite.revoke`) and `invitePublicRoutes` under
  `/api/invites` (`/inspect`, `/accept`; rate-limited with the pairing claim's
  `createFixedWindowLimiter`; `invite.accept` audited as the new user). The token travels only
  in POST bodies, so it never lands in an access log.
- **Accept** spends a use through a compare-and-swap `UPDATE` inside the transaction that
  creates the user, so two concurrent accepts cannot overspend, and a failed attempt (taken
  username, short password) leaves the invite unspent. New passwords need ≥ 8 characters.
- **Link base**: the pairing QR's `candidateUrls` (Funnel URL, then the request origin, loopback
  dropped). When nothing but loopback is known, the card builds the link from the page's own
  origin and shows "only works on this computer" (`buildInviteLink` → `localOnly`).
- **Web**: `InvitesCardComponent` inside Admin → User Management (Invite dialog → link + QR
  shown once → list with Pending/Used/Expired/Revoked, *New link*, *Revoke*);
  `InviteAcceptComponent` at the public `/invite` route, with one state per outcome
  (`form`, `signed-in`, `invalid`, `expired`, `used`, `revoked`) exposed as `data-state`.
- **Fix that came with it**: the radio provider's boot-time `GET /api/settings/radio` ran
  before any session existed, and its 401 made the interceptor sign out and jump to `/login`,
  hijacking **every** public page opened without a session. It now passes
  `getRadioSettings({ background: true })` (`KEEP_SESSION_ON_401`), the 401 it already
  expected.
- **Tests**: `routes/invites.test.ts` (API), `invites-card.component.spec.ts`,
  `invite-accept.component.spec.ts`, `lib/invite-link.spec.ts`, and the e2e
  `invite-link.spec.ts` (a fresh browser context joins at the preset role; the reused link reads
  *used*; a revoked link reads *revoked*).

## Shipped: account security without email (increment 2)

- **Session versions**: `users.token_version`, carried in every JWT as `tv` (`JwtPayload.tv`).
  `signJwt` stamps the current value itself (via `sessionVersionOf`), so no mint site can
  forget it; `authMiddleware` refuses a mismatch with `401 SESSION_REVOKED`
  (`sessionVersionMatches`). A token minted before this existed has no `tv` and reads as 0, so
  nobody was signed out by the upgrade. Share tokens are exempt — their subject is the link's
  creator. `bumpSessionVersion` is "sign out everywhere".
- **Every password write bumps it**: the user's own change (`PUT /api/me/account/password`,
  `changePassword` — proves the current password, returns a fresh token for this device and keeps
  a paired device's `deviceId`), a reset link (`completeReset`), and the admin's existing
  *Set password…* (`PUT /api/admin/users/:id/password`), which now also ends the user's sessions.
- **OpenSubsonic**: the upstream's cached internal session dies with a bump while the client's
  API key is still good, so `internalUpstream` re-mints once on `SESSION_REVOKED`.
- **Reset links**: `password_resets` (hashed, single use, one live link per user, 24 h when an
  admin issues it — `ADMIN_RESET_TTL_MS`). `passwordResetAdminRoutes` at
  `/api/admin/password-resets`; `passwordResetPublicRoutes` at `/api/password-reset`
  (`/inspect`, `/complete`, rate-limited). Spending is a compare-and-swap, so two tabs cannot
  both set a password; a short password leaves the link unspent.
- **Web**: *Copy reset link* in the users table's ⋯ menu (a dialog showing the link once, with
  the same local-only warning as invites); the public `ResetPasswordComponent` at
  `/reset-password`; `AccountSettingsComponent` at `/settings/account` (linked from Settings →
  Account), the first place a user can change their own password.
- **Tests**: `routes/password-reset.test.ts`, the session-version block in
  `middleware/auth.test.ts`, `opensubsonic-upstream.test.ts`, the account/reset/user-management
  specs, and the e2e `account-security.spec.ts` (reset link → new password works, old one and
  old sessions do not; Settings change keeps this browser signed in and ends the others).

## Today (verified)

- `users` has no email: `id, username, password_hash, role, created_at` (`packages/api/src/db.ts`).
- Admins create users and *type* a new password for them (`POST /api/admin/users`,
  `PUT /api/admin/users/:id/password`); minimum length is 4.
- A user cannot change their own password anywhere in the web UI.
- Public signup is default-closed (`registrationEnabled`, env-pinnable).
- Public token-in-fragment pages already exist: `/pair#t=`, `/approve#c=`, `/share/:token`.
- Link base candidates already exist server-side (`services/pairing-urls.ts`, Funnel URL first).
- An in-process limiter exists (`createFixedWindowLimiter`, `routes/devices.ts`).
- JWTs are stateless 30-day sliding tokens — "sign out everywhere" needs new state.

## Mailgun reality (check the live pricing page before relying on it)

- The free plan is about **100 emails/day**. That is plenty for invites and recovery on a home server.
- The **sandbox domain only delivers to ~5 pre-authorized, confirmed recipients**.
  It is good for testing, not for inviting friends.
- Real sending needs a **verified custom domain**: SPF and DKIM DNS records on a domain
  the self-hoster owns. Several sources say sending to arbitrary recipients also needs
  a card on file.
- A Tailscale Funnel user (`*.ts.net`) cannot add DNS records there. They need some
  other domain they own.
- Conclusion: links-first is not optional, and core must not depend on any one provider.

## Provider-agnostic by design

Core knows one interface and nothing about vendors:

```ts
interface MailTransport {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<MailResult>;
  verify(): Promise<MailResult>; // used by "Send test email" and the settings card
}
type MailResult =
  | { ok: true; providerId?: string }
  | { ok: false; reason: 'auth' | 'sender-rejected' | 'recipient-rejected' | 'rate-limited' | 'unreachable' | 'unknown'; detail: string };
```

- **SMTP is the baseline transport**, not a follow-up. Every provider speaks it: Mailgun,
  Brevo, Postmark, Resend, SES, SendGrid, Fastmail, Gmail/Outlook app passwords, a
  self-hosted Postfix. One adapter covers them all.
  - Built on `nodemailer`: zero dependencies and no install hook. Add it through the usual
    `check:install-scripts` / `check:audit` review.
  - Config: host, port (587 STARTTLS default, 465 implicit TLS), username, password, From.
- **Presets, not code, per provider.** The settings card offers *Mailgun*, *Brevo*,
  *Gmail*, *Fastmail*, *Custom SMTP*. A preset only pre-fills host, port and help text
  (for example "Mailgun: smtp.mailgun.org:587, user `postmaster@<domain>`, EU uses
  smtp.eu.mailgun.org"). Adding a provider is a JSON entry plus a docs line.
- **HTTP API adapters are optional extras** behind the same interface, for hosts where
  outbound SMTP ports are blocked. Some VPS and residential ISPs block 25, and occasionally
  587/465. Mailgun HTTP would be the first; none is required to ship.
- **Everything else stays provider-neutral**: the quota meter and daily cap (counted in
  the local `mail_send_log`, never asked of the provider), templates (plain text and simple
  HTML rendered by core), the `outbox` test transport, and error reasons. Each adapter maps
  its own codes onto `MailResult.reason`; SMTP, for example, maps 535 → `auth`,
  550/553 → `recipient-rejected`/`sender-rejected`, 421/450/451/452 → `rate-limited`.
- **Optional hardening**: disable provider link or open tracking, where the provider allows
  it, so token links are never rewritten. This is a per-preset note, not a core concern.
- **Config**: `NICOTIND_MAIL_TRANSPORT=smtp|outbox|off` (plus `mailgun-api` if that
  adapter ships), with `NICOTIND_SMTP_HOST/PORT/USER/FROM`. The password lives in
  `secrets.json` or `NICOTIND_SMTP_PASSWORD`. Env pins the UI read-only, the same as the
  registration switch.

## Engineering rules (apply to every increment)

- **Tokens**:
  - 32 random bytes, base64url, carried in the URL **fragment** (never sent in Referer or logged by proxies).
  - Stored **only as SHA-256**, single-use, with expiry: invite 7 d (default), reset 30 min, email-verify 24 h.
  - Compared in constant time. Expiry tests use an injected clock.
- **Sessions**: a `token_version` on `users`, embedded in the JWT and checked by the auth
  middleware and at refresh. A reset or password change bumps it, which signs out everywhere.
- **Passwords**: new flows (accept, reset, change) require ≥ 8 characters. The admin "set password" flow keeps working as is.
- **Adapters**: no vendor names outside `services/mail/transports/` and the presets file.
  An optional Mailgun HTTP adapter would use plain `fetch` (no SDK) with
  `o:tracking-clicks=no`, and map 401 → `auth`, 402/403 → `sender-rejected`,
  429 → `rate-limited`.
- **Quota**:
  - A local `mail_send_log` (kind, recipient, status, provider id, **never the token**) drives an "N / cap today" meter. The cap defaults to 100 and is admin-editable.
  - Reserve headroom for recovery, so an invite burst can't block resets.
- **Abuse**:
  - `/api/auth/forgot` returns the same body, status and timing for every input.
  - It is rate-limited per IP and per account, and has its own daily share of the quota, so an anonymous caller can't burn the day's budget.
  - Only **verified** emails receive reset links.
- **Secrets**: the API key goes in `secrets.json` (write-only in the UI, never logged). Env vars pin config, read-only in the UI, the same as the registration switch.
- **Audit**: invite create/revoke/accept, reset-link issue/send and password change all call `recordAudit`.
- **Privacy**: emails are PII sent to a third party, so update [privacy.md](privacy.md) in the increment that first stores one.
- **Routes**: every new `/api` group gets an explicit auth decision (`check:route-auth`).
  The test outbox endpoint is **mounted only** when `NICOTIND_MAIL_TRANSPORT=outbox`.

## UX placement (from the UX assessment)

| Piece | Where |
| --- | --- |
| Invite button, pending-invites card (status, revoke, resend) | Admin → User Management group (`user-management-panel.component.*`) |
| Email delivery card (provider preset, SMTP host/port/user/password, From, link base, test send, quota) | New card after User Management in `admin.component.html` |
| Invite landing | Public `/invite#t=` (`pages/invite/`) |
| Forgot password | Link on login (never on TV) → `/forgot-password`; landing `/reset-password#t=` |
| Own email + change password | New `/settings/account`, first link in Settings → Account |
| Admin reset | ⋯ menu splits into *Copy reset link* / *Email reset link* / *Set password…* |

**Degraded state:** when email is off, every email option is disabled with a reason and
falls back to the link. Forgot password then reads "Ask your server admin."

**Surfaces:**
- **TV:** no TV routes. A TV invitee accepts on a phone, then uses `/approve`.
- **Mobile:** opens the web page in the system browser. Per-domain App Links are infeasible for self-hosted domains.
- **Desktop:** link building never falls back to loopback, and the UI shows "only works on your network" when that is all there is.

## Increments (one PR each, each independently useful)

1. **Link invites.** ✅ Shipped — see above.
   - Ships: `invites` table (hashed token, role ≤ inviter, expiry, uses ≤ 25, revoked); admin API; invites card with copy and QR; `/invite` accept page.
   - Invites work while public signup is closed.
   - Tests: API unit tests (expiry, reuse, role cap, revoke) and e2e `invite-link.spec` (fresh context accepts, reopen shows *used*).
2. **Account security, still without email.** ✅ Shipped — see above.
   - Ships: `token_version` session revocation, `/settings/account` with change password, admin *Copy reset link*, and `/reset-password`.
   - Tests: e2e `admin-reset-link.spec` (old password fails afterwards).
3. **Mail transport.**
   - Ships: `MailTransport` with `smtp` and `outbox` implementations; provider presets (Mailgun first); the email card; test send (to the admin, with a link that proves the base URL opens); send log and quota meter.
   - Tests: a **contract test suite** every adapter must pass (send, verify, each `reason`), run against `outbox` and against the SMTP adapter talking to an in-process fake SMTP server (auth failure, 550, 421, TLS on/off). The Playwright server boots with the outbox. Manual check: one real send per preset before release.
4. **Email invites.**
   - Ships: nullable, unique, lower-cased `users.email`. An emailed invite captures the email at accept time, already verified because the link was clicked.
   - Tests: e2e `invite-email.spec` reads the outbox filtered by a per-spec recipient.
5. **Recovery.**
   - Ships: add, verify and change your own email; forgot password (**default off**, can only be enabled after a successful test send); admin *Email reset link*; a "your password was changed" notice.
   - Tests: e2e `forgot-password.spec` checks identical UI for known and unknown users, with 1 vs 0 outbox messages.
6. **Later.** Optional HTTP API adapters (Mailgun first) for SMTP-blocked hosts; each must pass the same contract suite. `nicotind://` "Continue in app", invite QR on TV.

Each increment adds `data-testid`s for new interactive elements and Storybook stories for
its states (empty, configured, failed, quota exhausted, expired, used, env-locked). The
"email not configured" states are covered by component tests and stories, because the e2e
server always has the outbox.

## Top risks

1. **Dead links**: the base URL resolves to loopback or LAN, or the Funnel URL changed. Mitigation: show the base URL, a self-verifying test email, and a loopback warning.
2. **Recovery as a takeover or enumeration vector**: covered by the abuse rules above, with recovery default off.
3. **Recovery is useless without emails on file**: capture the email at invite accept, and nudge in the welcome banner.
