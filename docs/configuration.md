# Configuration reference

Configuration is loaded from `config/default.yml` and overridden by environment
variables. `.env.example` in the repo root lists every option and is the source
of truth; this page summarizes the ones most installs touch.

| Variable                              | Default                 | Description                                                    |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `NICOTIND_PORT`                        | `8484`                  | API server port                                                |
| `NICOTIND_DATA_DIR`                    | `~/.nicotind`           | Data directory (SQLite DB, secrets, artist-overrides)          |
| `NICOTIND_MUSIC_DIR`                   | `~/Music`               | Shared music folder                                            |
| `NICOTIND_DOWNLOADS_DIR`               | `.downloads`            | Acquisition staging; top-level name under the music dir, or an absolute path |
| `NICOTIND_MODE`                        | `embedded`              | `embedded` (best-effort manage Lidarr; slskd is its own addon) or `external` (connect to existing) |
| `NICOTIND_ACQUISITION`                 | `on`                    | Deployment-wide acquisition kill-switch (`off` = streaming-only install) |
| `NICOTIND_REGISTRATION`                | *(unset)*               | Public self-signup. Unset = the Admin → User Management toggle owns it (starts closed); setting `off`/`on` pins it and makes that toggle read-only |
| `NICOTIND_METADATA_FIX_ENABLED`        | `true`                  | Auto-repair missing MP3 tags after download                    |
| `NICOTIND_METADATA_FIX_MIN_SCORE`      | `85`                    | Minimum MusicBrainz match score (0-100) for auto-fill          |
| `NICOTIND_TRANSCODE_LOSSLESS_ENABLED`  | `true`                  | Transcode FLAC → Opus in place after download                  |
| `NICOTIND_TRANSCODE_LOSSLESS_BITRATE`  | `192`                   | Opus bitrate in kbps                                           |
| `SLSKD_ADDON_TOKEN` / `SLSKD_ADDON_SLSKD_*` | — | Addon-container envs (bearer token core registers with; slskd URL/creds) — see [acquisition-addon-protocol.md](acquisition-addon-protocol.md) |
| `NICOTIND_ANALYSIS_URL`                | —                       | Essentia analysis sidecar URL (BPM/key/mood inference)         |
| `NICOTIND_SENTRY_DSN`                  | — (off)                 | Server-side Sentry error reporting                             |
| `NICOTIND_UPDATE_CHECK`                | `on`                    | Daily GitHub-releases update check (`off` to disable)          |
| `NICOTIND_BACKUP*`                     | see [backup-restore.md](backup-restore.md) | Daily backup schedule + retention           |
| `NICOTIND_MIGRATION_BACKUP*`           | see [backup-restore.md](backup-restore.md) | Pre-migration snapshot (own switch + keep)  |

Related pages:

- [deployment.md](deployment.md) — Docker install, image tags, upgrade/rollback,
  the streaming-only profile, GPU passthrough for the analysis sidecar.
- [backup-restore.md](backup-restore.md) — backup schedule, `NICOTIND_BACKUP*`, `NICOTIND_MIGRATION_BACKUP*`
  envs, manual restore.
- [config-export.md](config-export.md) — portable JSON export/import of the
  human-decision config tables (host migration).
