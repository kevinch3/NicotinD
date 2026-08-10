# Configuration reference

Configuration is loaded from `config/default.yml` and overridden by environment
variables. `.env.example` in the repo root lists every option and is the source
of truth; this page summarizes the ones most installs touch.

| Variable                              | Default                 | Description                                                    |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `NICOTIND_PORT`                        | `8484`                  | API server port                                                |
| `NICOTIND_DATA_DIR`                    | `~/.nicotind`           | Data directory (SQLite DB, secrets, artist-overrides)          |
| `NICOTIND_MUSIC_DIR`                   | `~/Music`               | Shared music folder                                            |
| `NICOTIND_MODE`                        | `embedded`              | `embedded` (manage sub-services) or `external` (connect to existing) |
| `NICOTIND_ACQUISITION`                 | `on`                    | Deployment-wide acquisition kill-switch (`off` = streaming-only install) |
| `NICOTIND_METADATA_FIX_ENABLED`        | `true`                  | Auto-repair missing MP3 tags after download                    |
| `NICOTIND_METADATA_FIX_MIN_SCORE`      | `85`                    | Minimum MusicBrainz match score (0-100) for auto-fill          |
| `NICOTIND_TRANSCODE_LOSSLESS_ENABLED`  | `true`                  | Transcode FLAC → Opus in place after download                  |
| `NICOTIND_TRANSCODE_LOSSLESS_BITRATE`  | `192`                   | Opus bitrate in kbps                                           |
| `SOULSEEK_USERNAME`                    | —                       | Your Soulseek account username                                 |
| `SOULSEEK_PASSWORD`                    | —                       | Your Soulseek account password                                 |
| `SLSKD_USERNAME`                       | `slskd`                 | slskd web login username                                       |
| `SLSKD_PASSWORD`                       | `slskd`                 | slskd web login password                                       |
| `NICOTIND_SLSKD_URL`                   | `http://localhost:5030` | slskd URL (external mode only)                                 |
| `NICOTIND_ANALYSIS_URL`                | —                       | Essentia analysis sidecar URL (BPM/key/mood inference)         |
| `NICOTIND_SENTRY_DSN`                  | — (off)                 | Server-side Sentry error reporting                             |
| `NICOTIND_UPDATE_CHECK`                | `on`                    | Daily GitHub-releases update check (`off` to disable)          |
| `NICOTIND_BACKUP*`                     | see [backup-restore.md](backup-restore.md) | Daily backup schedule + retention           |

Related pages:

- [deployment.md](deployment.md) — Docker install, image tags, upgrade/rollback,
  the streaming-only profile, GPU passthrough for the analysis sidecar.
- [backup-restore.md](backup-restore.md) — backup schedule, `NICOTIND_BACKUP*`
  envs, manual restore.
- [config-export.md](config-export.md) — portable JSON export/import of the
  human-decision config tables (host migration).
