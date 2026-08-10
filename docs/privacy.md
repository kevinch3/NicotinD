# Privacy & data protection

Consent, access, erasure and retention for the data NicotinD holds about a person (issue #454).

Until the listening log shipped, this app held almost nothing personal: a username, a password hash,
per-user settings, playlists. `play_events` ([listening-history.md](listening-history.md)) changed
that — it is a per-user, timestamped, indefinitely-retained behavioural record. That is personal
data in a way a playlist is not, and a self-hoster running an instance for family or friends is,
strictly, a controller. This gives them the tools rather than leaving it to them.

| Piece | File |
| --- | --- |
| Consent, export, erasure, retention | `packages/api/src/services/privacy.ts` |
| User-facing endpoints | `packages/api/src/routes/privacy.ts` → `/api/privacy` |
| Write-path enforcement | `packages/api/src/routes/history.ts` |
| Instance controls | `packages/api/src/routes/admin.ts` → `/api/admin/history-privacy` |
| Env floor | `config.historyEnabled`, env `NICOTIND_HISTORY=off` |
| Settings page | `packages/web/src/app/pages/settings/privacy/` |
| Client back-off | `services/listening-queue.service.ts` |

## Consent: opt-out, three levels

```
env NICOTIND_HISTORY=off   →  hard floor, no one collects
instance setting = false   →  off for every user on this server
user setting = false       →  off for that user
otherwise                  →  ON  (the opt-out default)
```

`resolveHistoryCollection(env, instance, user)` is pure and holds that precedence on its own.

**Opt-out, not opt-in**, and the reasoning is worth keeping: opt-in is the safer legal posture, but
the Stats tab and the radio recency demotion would silently do nothing until every user found a
toggle — and on a personal instance you would be opting in to your own data. The visible Privacy
page plus a one-click off switch is the honest middle.

**The env var is a hard floor an admin cannot lift**, exactly like the acquisition kill-switch
(#235). An operator who disabled behavioural logging must not be overridden by whoever happens to
hold an admin account. `historyCollectionState` reports the *most restrictive* blocker so the UI can
explain rather than offer a control that silently does nothing.

**Enforcement is server-side**, in `POST /api/history/plays`. A device on an old bundle, or one
whose toggle hasn't synced, must not be able to write history the user turned off. The response
carries the collection state rather than a bare success, so the client stops buffering instead of
retrying forever — `ListeningQueueService` sets an in-memory `collectionDisabled` flag and drops the
refused batch. Retrying rejected events forever is worse than losing history the user asked us not
to keep.

## Access (Art. 15)

`GET /api/privacy/export` returns everything tied to the caller as JSON, `Content-Disposition:
attachment` so a browser saves it.

Columns are read from `PRAGMA table_info` at runtime rather than hardcoded — the same technique as
the admin config export. A schema change must not silently start omitting a column from someone's
data request. Tables absent from the running schema are reported in `skipped`, so a gap is visible
rather than silent.

`redact` names columns whose *value* is a secret (today: `agent_tokens.token_hash`). The export
shows that a credential exists — it is the user's data — without handing over the credential. The
list is explicit rather than name-pattern-matched, so a rename breaks a test instead of quietly
starting to leak.

## Erasure (Art. 17)

`DELETE /api/privacy/history` wipes the caller's `play_events` and returns the count.

**Scoped to the listening log, deliberately.** It does not touch the account, playlists or likes:
"stop remembering what I listened to" is the realistic ask, `play_events` is regenerable by
listening, and nothing else references it. Account deletion stays with the admin route.

It also **does not flip the consent flag** — "forget what I listened to" and "stop recording" are
different asks, and silently doing the second when asked for the first is its own surprise.

Audit-logged like every destructive action, recording only that the user erased their own history
and how many rows — never what was in them. A ledger must not become a copy of the thing just
erased; there is a test for that.

**Account deletion was audited, not assumed.** `playlist_visibility.created_by`/`modified_by`
reference `users(id)` *without* `ON DELETE CASCADE`, which looks like it would make
`DELETE FROM users` fail under `PRAGMA foreign_keys=ON`. Tested empirically: it doesn't, because
`owner_id` on the same table cascades, so the row is gone before the non-cascading columns matter.
No fix needed — recorded here so the next person doesn't re-derive it.

## Retention

Instance-wide `history_retention_days`; **0 = keep forever, the default and the pre-#454 policy**.
A year review needs multi-year data, so this exists so an operator who wants a bound can set one,
not to impose one.

Swept once a day by `maybeRunDailyHistoryRetention` on the processor tick, marker-guarded in
`library_sync_state` alongside the backup / orphan / cover-cache passes — housekeeping must not
depend on enrichment being enabled. Unlike the orphan prune there is **no grace period and no
mark/sweep**: an event past the cap is past the cap, and the point is that it stops existing.

Failures are caught so a retention error can never break the processing tick — but they are
**logged**. Swallowing silently is how a missing `updated_at` in the marker insert looked exactly
like "nothing to prune" instead of a bug during development.

## Transparency

Settings → Privacy states in plain language what is stored, that history is private to the user,
that admins see only a total count, and which third parties the app can contact (MusicBrainz,
ListenBrainz, Discogs, LRCLIB, Lidarr — those carry track and artist names, never identity).
Playing music never leaves the server.

It is prose on the page rather than a link to this file: someone deciding whether to turn
collection off should not have to leave the app to find out what it does.

## Deliberately not built

- **Self-service account deletion.** A foot-gun on a shared instance, and the admin route exists.
- **Admin access to a user's history.** There is no route, by design — that is the surveillance
  surface this work exists to avoid. Admins see `totalEvents`, a count.
- **Anonymised cross-user analytics.** Phase 4 of the listening roadmap. Note the caveat recorded in
  [listening-history.md](listening-history.md): on a three-user instance "most played across all
  users" is not meaningfully anonymous. Settle that before building it.
