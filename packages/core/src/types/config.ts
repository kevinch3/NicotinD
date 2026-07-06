import { z } from 'zod';

export const ServiceModeSchema = z.enum(['embedded', 'external']);
export type ServiceMode = z.infer<typeof ServiceModeSchema>;

export const NicotinDConfigSchema = z.object({
  port: z.number().default(8484),
  dataDir: z.string().default('~/.nicotind'),
  musicDir: z.string().default('~/Music'),
  mode: ServiceModeSchema.default('embedded'),
  registrationEnabled: z.boolean().default(true),
  metadataFix: z
    .object({
      enabled: z.boolean().default(true),
      minScore: z.number().min(0).max(100).default(85),
    })
    .default({ enabled: true, minScore: 85 }),

  downloads: z
    .object({
      // Auto-retry/recovery for failed slskd transfers (resume truncated
      // downloads, cross-peer fallback for tracks that keep failing).
      autoRetryEnabled: z.boolean().default(true),
      retryMaxAttempts: z.number().int().min(0).default(3),
      retryIntervalMs: z.number().int().min(1000).default(15_000),
      retryCooldownMs: z.number().int().min(0).default(60_000),
      // Max cross-peer fallback waves per album (recorded alternates + fresh
      // per-track searches) before a job is marked exhausted.
      fallbackMaxAttempts: z.number().int().min(0).default(5),
      // Periodically revive `exhausted` album jobs for another fallback wave —
      // peers that were offline at hunt time often reappear. Disk-aware, so it
      // only re-searches tracks still genuinely missing from the library.
      autoRetryExhausted: z.boolean().default(true),
      // Minimum delay before re-trying the same exhausted job (default 1h).
      exhaustedRetryCooldownMs: z.number().int().min(0).default(3_600_000),
      // Cap on how many times one job is revived before it stays exhausted.
      exhaustedMaxRevives: z.number().int().min(0).default(5),
      // Drop an incoming MP3 when a FLAC of the same track is already in the
      // album folder (avoids mixed MP3+FLAC duplicate albums). Opt-in.
      preferFlacSkipMp3: z.boolean().default(false),
      // Native auto-acquisition loop: a background poller over Lidarr's
      // wanted/missing list that auto-hunts + downloads monitored albums Lidarr
      // lacks, through the same engine as the interactive hunt. Opt-in (off by
      // default) — it initiates downloads unattended. See docs/auto-acquisition-plan.md.
      autoAcquireEnabled: z.boolean().default(false),
      // How often the loop sweeps Lidarr's missing list (default 1h).
      autoAcquireIntervalMs: z.number().int().min(10_000).default(3_600_000),
      // Max albums acquired per sweep, so a large missing list never floods slskd.
      autoAcquireMaxPerSweep: z.number().int().min(1).default(3),
      // Standardize on a small, browser-native codec for storage + web playback:
      // transcode lossless downloads (FLAC/WAV/…) to Opus in place before they
      // enter the library, leaving already-lossy files untouched. Default-on at
      // 192 kbps (transparent headroom since the source lossless file is dropped).
      transcodeLossless: z
        .object({
          enabled: z.boolean().default(true),
          // Only opus today; left as an enum for headroom.
          format: z.enum(['opus']).default('opus'),
          bitRate: z.number().int().min(64).max(320).default(192),
        })
        .default({ enabled: true, format: 'opus', bitRate: 192 }),
    })
    .default({
      autoRetryEnabled: true,
      retryMaxAttempts: 3,
      retryIntervalMs: 15_000,
      retryCooldownMs: 60_000,
      fallbackMaxAttempts: 5,
      autoRetryExhausted: true,
      exhaustedRetryCooldownMs: 3_600_000,
      exhaustedMaxRevives: 5,
      preferFlacSkipMp3: false,
      autoAcquireEnabled: false,
      autoAcquireIntervalMs: 3_600_000,
      autoAcquireMaxPerSweep: 3,
      transcodeLossless: { enabled: true, format: 'opus', bitRate: 192 },
    }),

  // Watchlist auto-hunt: a background poller re-hunts watched albums and
  // auto-downloads them once a confidently-complete folder appears.
  watchlist: z
    .object({
      enabled: z.boolean().default(true),
      // How often the poller runs (default 30 min).
      intervalMs: z.number().int().min(10_000).default(1_800_000),
      // Minimum folder match % to auto-acquire a watched album unattended. Higher
      // than the interactive floor — unattended downloads should be confident.
      minMatchPct: z.number().int().min(0).max(100).default(80),
    })
    .default({ enabled: true, intervalMs: 1_800_000, minMatchPct: 80 }),

  soulseek: z.object({
    username: z.string().default(''),
    password: z.string().default(''),
    listeningPort: z.number().default(50000),
    enableUPnP: z.boolean().default(true),
  }),

  slskd: z.object({
    url: z.string().url().default('http://localhost:5030'),
    port: z.number().default(5030),
    username: z.string().default('nicotind'),
    password: z.string().default(''),
  }),

  lidarr: z
    .object({
      url: z.string().url().default('http://localhost:8686'),
      port: z.number().default(8686),
      apiKey: z.string().default(''),
    })
    .optional(),

  acquire: z
    .object({
      ytdlp: z
        .object({
          // On by default — the production image ships the binary. Availability
          // is still gated on the binary actually being present at runtime.
          enabled: z.boolean().default(true),
          binaryPath: z.string().default('yt-dlp'),
          format: z.enum(['mp3', 'opus', 'bestaudio']).default('bestaudio'),
          extraArgs: z.array(z.string()).default([]),
        })
        .default({ enabled: true, binaryPath: 'yt-dlp', format: 'bestaudio', extraArgs: [] }),
      spotdl: z
        .object({
          enabled: z.boolean().default(true),
          binaryPath: z.string().default('spotdl'),
        })
        .default({ enabled: true, binaryPath: 'spotdl' }),
      archive: z
        .object({
          // Pure-JS plugin (no binary). `enabled` only feeds isAvailable(); the
          // real gate is the admin enabling the `archive` plugin in Settings.
          enabled: z.boolean().default(true),
          // Audio format preference, matched as a substring of archive.org's
          // `format` field. MP3 first (smaller), FLAC fallback.
          preferredFormats: z.array(z.string()).default(['MP3', 'FLAC']),
        })
        .default({ enabled: true, preferredFormats: ['MP3', 'FLAC'] }),
      spotify: z
        .object({
          // Metadata-only fallback lane (download is spotDL's job). `enabled`
          // feeds isAvailable(); the real gate is the admin enabling the
          // `spotify` plugin + entering credentials in Settings. The creds here
          // only seed the config (env path); the UI is the primary way to set them.
          enabled: z.boolean().default(true),
          clientId: z.string().default(''),
          clientSecret: z.string().default(''),
        })
        .default({ enabled: true, clientId: '', clientSecret: '' }),
    })
    .default({
      ytdlp: { enabled: true, binaryPath: 'yt-dlp', format: 'bestaudio', extraArgs: [] },
      spotdl: { enabled: true, binaryPath: 'spotdl' },
      archive: { enabled: true, preferredFormats: ['MP3', 'FLAC'] },
      spotify: { enabled: true, clientId: '', clientSecret: '' },
    }),

  // Audio-analysis sidecar (packages/analysis). Empty url = not configured —
  // the audio-features enrichment task reports itself unavailable and
  // everything else works normally.
  analysis: z
    .object({
      url: z.string().url().or(z.literal('')).default(''),
    })
    .default({ url: '' }),

  jwt: z.object({
    secret: z.string().min(32, 'JWT secret must be at least 32 characters'),
    expiresIn: z.string().default('30d'),
  }),
});

export type NicotinDConfig = z.infer<typeof NicotinDConfigSchema>;
