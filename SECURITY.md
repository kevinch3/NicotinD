# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub's [private vulnerability
reporting](https://github.com/kevinch3/NicotinD/security/advisories/new) — the
"Report a vulnerability" button under the Security tab. That creates a draft
advisory only you and the maintainer can see.

NicotinD is maintained by one person in their own time. Realistic expectations:

| | |
|---|---|
| Acknowledgement | within a week |
| Assessment + plan | within two weeks |
| Fix | as fast as severity warrants; a critical issue in a shipped default takes priority over everything else |

If you get no acknowledgement in two weeks, assume the report was missed rather
than ignored, and open a public issue saying only *that* you sent a private
report — no details.

## Scope

NicotinD is **self-hosted**. There is no service to attack: every install is
someone's own machine, and the maintainer runs no infrastructure on your behalf.
What matters here is what the shipped artifacts do on your host.

In scope:

- The published image `ghcr.io/kevinch3/nicotind` and the `docker-compose.yml`
  in this repo, **including their defaults** — a default that is unsafe out of
  the box is a real finding, not a configuration choice.
- The API: authentication and authorization, the JWT and share-token model,
  agent tokens, SSRF in the remote-cover proxy, path traversal in the library
  scanner / organizer / archive import.
- Anything that lets a lower role do a higher role's work — see
  [docs/roles.md](docs/roles.md).
- The privacy guarantees in [docs/privacy.md](docs/privacy.md): consent
  enforcement, export completeness, erasure.

Out of scope:

- The addon repos (`nicotind-slskd-addon`, `-ytdlp-addon`, `-spotdl-addon`) —
  report those on their own trackers.
- Third-party services NicotinD talks to (Lidarr, MusicBrainz, Discogs, LRCLIB,
  ListenBrainz, archive.org).
- Anything requiring an attacker who already has admin on the host.
- Content acquisition and copyright. Not a security matter; not handled here.

## Known unsafe defaults, being removed

Disclosed rather than quietly carried, because the image is public and these are
what a new self-hoster gets. Both are announced now and **removed in 0.4.0**;
until then a running instance logs a warning at boot naming each one.

| Default | Why it matters |
|---|---|
| `/var/run/docker.sock` bind-mounted into the container | The Docker API is read-write regardless of the `:ro` flag, so this is host-root-equivalent privilege — granted for one admin log viewer. In 0.4.0 it leaves the default compose file; see `docker-compose.override.example.yml`. |
| Addon tokens defaulting to `change-me` | Anything that can reach the addon on the Docker network can drive it. In 0.4.0 the addons refuse to start without a real token. |

Neither is a vulnerability report we need — they're tracked in
[#612](https://github.com/kevinch3/NicotinD/issues/612). A way to *exploit* them
that we haven't described is very much worth reporting.

## Supported versions

Only the latest release. There is no backport branch — the fix ships in the next
tag, which is usually the same day.
