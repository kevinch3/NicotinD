# Invitations, email delivery & password recovery

> **Status: all five increments shipped** — 1 (link invites), 2 (account security), 3 (mail
> transport), 4 (email invites) and 5 (self-service email and recovery); 6 ("Later") is not planned work. The plan below
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
- **Link base**: the pairing QR's `candidateUrls` (since increment 3: the operator's public URL,
  then the Funnel URL, then the request origin, loopback dropped — `linkBaseCandidates`). When nothing but loopback is known, the card builds the link from the page's own
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

## Shipped: mail transport (increment 3)

- **One interface** (`services/mail/transport.ts`): `MailTransport` with `send`/`verify`, both
  returning a `MailResult` — never throwing — whose `reason` is one of `MAIL_FAILURES`. Nothing above
  it sees a vendor code.
- **SMTP** (`services/mail/smtp.ts`, on `nodemailer`, which ships its own types — no `@types`
  package): `createSmtpTransport`, one connection per send, always with `SMTP_TIMEOUTS` (10 s
  connect, 10 s greeting, 20 s socket — nodemailer's own defaults are minutes). `classifySmtpError`
  maps the reply code *and* the phase: 530/534/535 → `auth`; 550/551/553 at `MAIL FROM` →
  `sender-rejected`, at `RCPT TO` → `recipient-rejected`, elsewhere `unknown`; 421/450/451/452 →
  `rate-limited`; socket/DNS/timeout codes → `unreachable`. The reply wins over nodemailer's own
  code (a refused greeting is `EPROTOCOL` + 421 → `rate-limited`).
  With a username on a non-implicit-TLS port, STARTTLS is **required** (`requireTLS`): a server
  — or an attacker in the path — that does not offer it gets no credentials and no mail. An
  unauthenticated local relay still works in plain text.
- **Outbox** (`services/mail/outbox.ts`): `createOutboxTransport` writes `mail_outbox`; `listOutbox`
  reads it. Selected only by `NICOTIND_MAIL_TRANSPORT=outbox`, and `GET /api/admin/mail/outbox` is
  registered only under it.
- **Presets are data** (`services/mail/presets.ts`, `MAIL_PRESETS`): Mailgun, Brevo, Resend,
  Gmail, Fastmail, Custom — host, port, TLS mode, a username hint, an optional fixed `username` (Resend's `resend`; switching provider fills it or clears the old one, #1904) and an i18n `helpKey`. Adding a provider
  is one entry plus its help text in `en.json`/`es.json`.
- **Settings** (`services/mail/settings.ts`, `MailSettingsStore`): non-secret fields as JSON in
  `app_settings` key `mail`; the password under its own key `mail_secret`, which config export
  drops unless secrets are opted in (`CONFIG_SECTIONS.app_settings.secretRows`) and which the API
  never returns (`passwordSet` only; a PUT without `password` keeps it, `''` clears it).
  `applyMailSettingsPatch` validates the whole result (port 1–65535, an email-looking From, a
  one-line From name, an http(s) public URL, cap 1–10000; host and From required for SMTP).
  **Env pinning by presence**, like the signup switch: `NICOTIND_MAIL_TRANSPORT` set ⇒ the whole
  block comes from `readMailEnv` (`NICOTIND_SMTP_*`, defaults for the rest), the stored settings are
  kept but unused, and the card is read-only (`MAIL_ENV_LOCKED` on PUT). `NICOTIND_SMTP_*` are read
  only under that pin. `NICOTIND_PUBLIC_URL` pins just the link base.
  - *Deviation from the plan above*: the password lives in `app_settings`, not `secrets.json`, so an
    admin can set it from the UI without the API writing the boot-time secrets file; the export
    exclusion is what keeps it out of a shared bundle.
- **`MailService`** (`services/mail/mailer.ts`, one instance from `createApp`, exported for
  increments 4–5): `send(kind, msg)` refuses with `off` while mail is off and with
  `quota-exhausted` once today's `sent` rows reach the cap (`startOfUtcDay`, 00:00 UTC), then logs
  every attempt to `mail_send_log` (kind, recipient, status, reason, provider id — never a subject,
  body or token). `usage()` drives the "N / cap today" meter. Failures and refusals do not count.
- **Link base**: `candidateUrls` takes an optional `publicUrl` first; invites, reset links and the
  test email all go through `linkBaseCandidates` (public URL → Funnel → request origin).
- **Template** (`services/mail/templates.ts`): `testEmail` — text plus inline-styled HTML (branded
  and localized since; see "Mail language and brand"), no remote assets, every value through `escapeHtml`, and a link to `<linkBase>/` so the test proves
  the base opens.
- **Routes** (`routes/mail.ts`, `mailAdminRoutes` at `/api/admin/mail`, admin-only): `GET /`,
  `PUT /` (audited `mail.settings` with the changed field *names*), `POST /test` (audited
  `mail.test`), and the outbox-only `GET /outbox?to=`.
- **Web**: `EmailDeliveryPanelComponent` (Admin → Email delivery, right after User Management; loads
  when the group opens), `MailApiService`. Env-locked renders every field read-only with a note but
  keeps the test send; failure reasons map to `admin.email.reason.*`.
- **Tests**: the transport contract suite (`transport-contract.test.ts`: send, verify and each
  reason, run against the outbox and against SMTP talking to the in-process
  `test-helpers/fake-smtp-server.ts` — auth 535, 553 at MAIL, 550 at RCPT, 421 greeting, 554 after
  DATA, a closed port, implicit TLS against a plain server, a silent server timing out), plus
  `smtp.test.ts`, `settings.test.ts`, `mailer.test.ts`, `templates.test.ts`, `routes/mail.test.ts`,
  the public-URL cases in the invite/reset/pairing tests, `email-delivery-panel.component.spec.ts`,
  and the e2e `email-delivery.spec.ts` (every Playwright server boots with the outbox; the spec
  sends through the locked card and reads its own recipient back from the outbox). A TLS *success*
  path is not covered in-process (it would need a certificate); "one real send per preset before
  release" stays a manual check.

## Shipped: email invites (increment 4)

- **Data**: `users.email` (nullable, stored trimmed and lower-cased by `normalizeEmail`, unique among
  the accounts that have one through the partial index `idx_users_email`) and
  `users.email_verified_at` (NULL = unverified); `invites.email` for an emailed invite. Shared
  helpers in `services/user-email.ts`: `parseOptionalEmail` (reuses `looksLikeEmail`),
  `emailTaken`, `userEmailOf`, `verifiedEmailOf`.
- **Mint**: `POST /api/admin/invites` takes an optional `email`. Given, it must look like an
  address (400), no account may already have it (409 `EMAIL_TAKEN`), and the invite is
  single-use (400 otherwise — one address, one account). The invite is created first, then
  `inviteEmail` (server name, inviter, role, link, expiry; every value HTML-escaped, the subject
  kept to one line) goes out through `MailService.send('invite', …)`. **A failed or refused send
  never fails the request**: the response carries `mail: MailSendResult` beside the usual link
  (`{ ok: false, reason: 'off' }` while mail is off) and the admin still has the link to pass on.
  The mailed link's base is the first `linkBaseCandidates` entry, else the admin's own origin —
  the test email's fallback. A link invite has no `mail` field.
- **Resend**: `POST /api/admin/invites/:id/link` on an emailed invite mails the fresh link to the
  same address and returns the same `mail` field.
- **Audit**: `invite.create` / `invite.rotate` add `emailed=true|false`; `invite.accept` adds
  `email=verified`. The address itself is never in the audit log (a test pins it).
- **Accept**: `inspectInvite` returns `email` for a pending emailed invite, and the landing page
  shows it read-only. Accepting sets the new account's `email` with `email_verified_at = now` —
  clicking the mailed link proves the inbox. If another account took the address between the send
  and the accept, the account is still created, without it (its owner can add one later), rather
  than stranding the invitee. A link invite accepts exactly as before.
- **Admin users list**: `GET /api/admin/users` adds `email` and `emailVerified` (not the timestamp);
  the users table shows the address under the username, wrapped rather than truncated, with
  Verified / Not verified.
- **Web**: the invite dialog's email field (`invite-email-input`) is disabled with a "Set up email"
  jump (`revealSettingsGroup('email-delivery')`) while `GET /api/admin/mail` says
  `effectiveTransport: 'off'`; with an address typed the submit reads *Send invite* and the uses
  field locks to 1. The result shows *Invite sent to …* (`invite-sent`) on success, or the reason
  (`admin.email.reason.*`) **and** the link + QR (`invite-mail-failed`) on failure. Invite rows show
  the address (`invite-email`).
- **Privacy**: the export's hand-projected `user` row gains `email` and `emailVerifiedAt`
  ([privacy.md](privacy.md)).
- **Tests**: the emailed-invites block in `routes/invites.test.ts` (validation, `EMAIL_TAKEN`,
  single-use, created when the send fails or mail is off, no address in the audit, resend on
  rotate, inspect, accept sets a verified address, taken-meanwhile), `templates.test.ts`
  (`inviteEmail`), `admin.presence.test.ts`, `privacy.test.ts`, the card/accept/users-table specs,
  `group-state.spec.ts`, and the e2e `invite-email.spec.ts` (sent through the UI, read back from
  the outbox, accepted from the mailed link in a fresh context, shown verified in Admin).

## Shipped: self-service email and recovery (increment 5)

- **Own email, verified by link**: `email_verifications` (user, the *pending* address, sha256
  `token_hash`, 24 h, `used_at`; one live row per user) in `services/email-verification.ts` —
  `startEmailVerification`, `pendingEmailOf`, `completeEmailVerification`. `PUT
  /api/me/account/email { email, currentPassword }` proves the password first (403
  `INVALID_CREDENTIALS`, never 401), then: empty clears the address; otherwise validates (400),
  refuses one another account has (409 `EMAIL_TAKEN`) or while mail is off (409
  `MAIL_NOT_CONFIGURED`), and mails `verifyEmail` (kind `verify`). **`users.email` does not change
  until the link is opened**, so a typo never replaces a working address. `GET /api/me/account` →
  `{ email, emailVerified, pendingEmail, mailEnabled }`. The public `POST /api/auth/verify-email
  { token }` spends the link by compare-and-swap in the transaction that sets the address; an
  address taken meanwhile is 409 `EMAIL_TAKEN` and leaves the link unspent.
- **Recovery switch**: `RecoverySetting` (`app_settings` key `recovery`, **default off**),
  `PUT /api/admin/mail/recovery { enabled }` (audited `mail.recovery`), refused with 409
  `MAIL_NOT_CONFIGURED` while the effective transport is `off`. Its own setting, so it stays
  usable while `NICOTIND_MAIL_TRANSPORT` pins the rest of the card; `effective()` also requires mail
  on, read per request, so turning mail off closes recovery with it. *Deviation from the plan*: it
  needs mail on, not a prior successful test send — the test send is one click away and a "proven
  once" flag would go stale the moment the provider changes.
- **Forgot password** (`recoveryPublicRoutes`, mounted beside `authRoutes` under `/api/auth`):
  `GET /recovery-status` → `{ enabled }`; `POST /forgot { identifier }` (username, or a verified
  email) **always answers `200 { ok: true }`** — unknown user, no or unverified email, disabled
  account, recovery off, the per-account throttle (one self-service reset per user per 15 minutes,
  counted from `password_resets` rows with `created_by IS NULL`) and an exhausted quota all look the
  same. The lookup always runs, an ineligible request does the same token work, and the mail is
  sent after the response, so timing does not tell either. A global `createFixedWindowLimiter`
  (20/min) is the only other answer (429), and it never looks at the identifier. An eligible request
  issues `issueResetToken(db, userId, null, 30 * 60_000, now)` and mails `resetEmail` (kind `reset`).
- **No Host-header links for anonymous requests**: the forgot link's base is the public URL, then
  the Funnel URL, then the origin the admin used when turning recovery on (stored with the switch)
  — never the forgot request's own `Host`, which its caller chooses (reset-link poisoning).
- **Quota headroom**: `MailService.send` refuses every kind but `reset` once `sentToday >= cap -
  resetReserve(cap)`; the reserve is `max(5, ceil(cap × 10%))`, never more than `cap - 1`
  (`capFor`). An invite burst cannot use up the day before someone needs back in.
- **"Password changed" notice**: `notifyPasswordChanged` after `changePassword`, `completeReset` and
  the admin's *Set password…* (now through `adminSetPassword`): `passwordChangedEmail` (kind
  `notice`, deliberately without a link) to the **verified** address while mail is on. Fire and log
  — a failed, refused or throwing send never breaks the password change.
- **Admin *Email reset link***: `POST /api/admin/password-resets { userId, send: true }` mails the
  24 h link to the verified address and returns `{ mail, expiresAt }` — no path, the admin never
  sees it (409 `MAIL_NOT_CONFIGURED` / `NO_VERIFIED_EMAIL`). Without `send` it is *Copy reset link*
  as before. The ⋯ menu item (`user-action-email-reset`) is disabled with a `title` reason when
  mail is off or the user has no verified address.
- **Web**: the login page shows *Forgot password?* (`login-forgot-link`) when recovery is on, else a
  muted "Ask your server admin" (`login-forgot-ask-admin`), never on TV and never while registering;
  the public `ForgotPasswordComponent` at `/forgot-password` shows one confirmation for every
  submit (`forgot-sent`), or `forgot-disabled`; the public `VerifyEmailComponent` at
  `/verify-email#t=` (`verify-state`: loading/done/invalid/expired/used/taken); Settings → Account's
  Email group (status verified / unverified / pending / none, address + current password, read-only
  while mail is off); the Email delivery card's `recovery-toggle`. Public calls carry
  `KEEP_SESSION_ON_401`.
- **Tests**: `routes/recovery.test.ts` (verification incl. CAS, expiry, reuse, taken-meanwhile,
  password required; forgot: identical responses across every case, only the verified address
  receives, per-account throttle, recovery off, quota exhausted, reserve, no Host-header link; the
  switch; admin `send: true`; notices sent and not sent), `mailer.test.ts` (reserve),
  `templates.test.ts`, `privacy.test.ts`, the login/forgot/verify/account/email-delivery/user-management
  specs, and the e2e `forgot-password.spec.ts` (recovery enabled through the locked card; a user
  verifies an address through the real flow; the same confirmation for them and for an unknown name,
  one reset mail; the link sets a password the old one no longer opens) and the verify block in
  `account-security.spec.ts`.

## Admin: assign an email

For accounts made before email existed (or by a plain link invite), the admin can name the address
from the users table's ⋯ menu (*Assign email…*, `user-action-assign-email`). The admin names it;
the user's inbox proves it.

- **Route** (`routes/admin-user-email.ts`, `adminUserEmailRoutes` at `/api/admin/user-emails`,
  admin-only): `PUT /:userId { email }`. Non-empty: validated (400), refused while mail is off (409
  `MAIL_NOT_CONFIGURED`) or when another account has it (409 `EMAIL_TAKEN`); otherwise it starts
  the same verification as the user's own change, through the shared `sendEmailVerification`
  (`services/mail/verify-mail.ts`), and returns `{ email, emailVerified, pendingEmail, mail }`.
  **`users.email` does not change until the link is opened** — a mistyped address never receives
  the account's reset links, and a verified address stays until its replacement is confirmed.
  Empty clears the address and any pending change (audited `user.email-clear`), which needs no
  mail: the way out of a wrong address the user cannot fix. Re-entering the verified address sends
  nothing. Audited `user.email-assign` with `emailed=true|false`, never the address.
- **The mail** is `verifyEmail` with `assignedBy`: "*boss* added this address to your account…",
  and "if you don't have an account there, ignore this" in place of "if you didn't ask for this".
  Language: the target user's saved one, else the admin's browser (`mailLangOf`).
- **Users list**: `GET /api/admin/users` adds `pendingEmail` (live links only; one
  `pendingEmailOf` per row — the users table is small). The row shows *Pending: …*
  (`user-email-pending`) under the address.
- **Web**: a dialog (`assign-email-dialog`) opening on the pending address, else the current one;
  submit reads *Send link*, or *Remove email* when empty; disabled with a note while mail is off
  unless removing. A failed send keeps the dialog open with the reason (the pending change exists;
  fix the address or retry); `EMAIL_TAKEN` reads as `account.emailTaken`.
- **Tests**: `routes/admin-user-email.test.ts`, the pending case in `admin.presence.test.ts`, the
  "Assign email" block in `user-management-panel.component.spec.ts`, and the e2e
  `assign-email.spec.ts` (assigned through the UI, read back from the outbox, confirmed from the
  link in a session-less browser, shown verified).

## Mail language and brand

- **Language** (`services/mail/mail-lang.ts`, `mailLangOf`): the recipient's saved language
  (`user_settings.language`), else the `Accept-Language` of the request that caused the mail
  (`negotiateLang`: by q-value, then order, matched on the base language), else English — the web
  app's own order, so the 5-of-6 prod accounts that never picked a language read mail as they read
  the app. Per mail: the test send and an invite follow the **admin** who sent it (an invitee has no
  account yet); verify follows the user; an admin's *Email reset link* and *Set password…* notice
  follow the target user, falling back to the admin's browser; a forgot-password mail follows the
  **account**, and only falls back to the anonymous request when the account saved none.
- **Words** (`services/mail/strings.ts`, `MAIL_STRINGS`): one object per language, `es` typed as the
  shape of `en`, so a sentence missing from one language is a typecheck failure. Kept in core
  rather than read from the web's `public/i18n/*.json`, which the API does not ship. Role names
  match the app's `admin.role.*` (English *refiner*, Spanish *curador*). Dates are
  `formatUtc(ms, lang)` with the language's month names; a link lifetime is `formatDuration`
  (`resetEmail` takes `ttlMs`, not a worded string).
- **Brand** (`templates.ts` `layout`): the app icon's colours — a dark `#09090b` header with an
  indigo `#6366f1` play mark drawn as a table cell with a CSS border triangle (no image: remote
  images are blocked or tracked, data URIs are stripped by Gmail; and no glyph: Gmail swapped ▶ for
  its orange emoji even with the text-presentation selector), the wordmark, the server name, a two-tone
  indigo/coral rule, an indigo button, an inbox preheader, and a footer naming the server. The
  layout is tables because clients that ignore `max-width` on a div honour it on a table.
  Gmail links any domain-shaped text, so the server name (often a hostname) came out blue and
  underlined in the header, title and footer: every visible name goes through `noAutolink`, a word
  joiner (U+2060) after each inner dot, which breaks the match without adding a wrap point. The
  text part and real `href`s are untouched. The text
  part ends with the same footer.

## Provider note: Brevo click tracking breaks token links

The first real Brevo send rewrote the email's button through Brevo's click-tracking redirect on the
branded subdomain (`r.<brand>.<domain>/tr/cl/…`), which had no valid certificate yet and, under the
domain's HSTS, could not be opened at all. Even with a certificate, tracking routes every invite and
reset token through the provider and risks dropping the `#t=` fragment. The Brevo preset's help text
now says to turn click and open tracking off and to send from an authenticated domain (otherwise
Brevo rewrites the sender to `…@<id>.brevosend.com`). This is a provider setting, not something the
SMTP transport can switch off.

## Provider note: Resend

`smtp.resend.com`, port 465 with implicit TLS (587 STARTTLS also works). The username is the literal
word `resend` and the password an API key with sending access; the From must be on a domain verified
in Resend. Resend's per-domain click tracking has the same effect as Brevo's above, so the preset's
help text says to leave it off.

## Fix after the first real send: the server's name

The first real Brevo test arrived as "Test email from 95fe07a0e91c": emails and the invite page
named the server with `os.hostname()`, which in Docker is the container id — meaningless to a
friend, and a random string spam filters weigh. `resolveServerName` now picks
`NICOTIND_SERVER_NAME`, then the public URL's host, then a hostname only when it is not a container
id, else `NicotinD`; `index.ts` passes that one `serverName` to every route that renders it.

## Before this work (verified 2026-11-09)

What the plan started from — every line here has since changed:

- `users` had no email: `id, username, password_hash, role, created_at` (`packages/api/src/db.ts`)
  — increment 4 added `email` and `email_verified_at`.
- Admins created users and *typed* a new password for them (`POST /api/admin/users`,
  `PUT /api/admin/users/:id/password`, minimum 4) — still possible, alongside reset links.
- A user could not change their own password, or recover a forgotten one — increments 2 and 5.
- Public signup is default-closed (`registrationEnabled`, env-pinnable).
- Public token-in-fragment pages existed: `/pair#t=`, `/approve#c=`, `/share/:token`.
- Link base candidates existed server-side (`services/pairing-urls.ts`, Funnel URL first).
- An in-process limiter existed (`createFixedWindowLimiter`, `routes/devices.ts`).
- JWTs were stateless 30-day sliding tokens with no "sign out everywhere" — increment 2.

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
  *Resend*, *Gmail*, *Fastmail*, *Custom SMTP*. A preset only pre-fills host, port and help text
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
  adapter ships), with `NICOTIND_SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`. Set from the UI, the
  password is write-only in `app_settings` (`mail_secret`, see increment 3). Env pins the UI
  read-only, the same as the registration switch.

## Engineering rules (apply to every increment)

- **Tokens**:
  - 32 random bytes, base64url, carried in the URL **fragment** (never sent in Referer or logged by proxies).
  - Stored **only as SHA-256**, single-use, with expiry: invite 7 d (default), reset 30 min, email-verify 24 h.
  - Compared in constant time. Expiry tests use an injected clock.
- **Sessions**: a `token_version` on `users`, embedded in the JWT and checked by the auth
  middleware and at refresh. A reset or password change bumps it, which signs out everywhere.
- **Passwords**: new flows (accept, reset, change) require ≥ 8 characters. The admin "set password" flow keeps working as is.
- **Adapters**: no vendor names outside the adapter files in `services/mail/` and the presets file.
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
3. **Mail transport.** ✅ Shipped — see above.
   - Ships: `MailTransport` with `smtp` and `outbox` implementations; provider presets (Mailgun first); the email card; test send (to the admin, with a link that proves the base URL opens); send log and quota meter.
   - Tests: a **contract test suite** every adapter must pass (send, verify, each `reason`), run against `outbox` and against the SMTP adapter talking to an in-process fake SMTP server (auth failure, 550, 421, TLS on/off). The Playwright server boots with the outbox. Manual check: one real send per preset before release.
4. **Email invites.** ✅ Shipped — see above.
   - Ships: nullable, unique, lower-cased `users.email`. An emailed invite captures the email at accept time, already verified because the link was clicked.
   - Tests: e2e `invite-email.spec` reads the outbox filtered by a per-spec recipient.
5. **Recovery.** ✅ Shipped — see above.
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
