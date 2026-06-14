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
      // Standardize on a small, browser-native codec for storage + web playback:
      // transcode lossless downloads (FLAC/WAV/…) to Opus in place before they
      // enter the library, leaving already-lossy files untouched. Opt-in.
      transcodeLossless: z
        .object({
          enabled: z.boolean().default(false),
          // Only opus today; left as an enum for headroom.
          format: z.enum(['opus']).default('opus'),
          bitRate: z.number().int().min(64).max(320).default(128),
        })
        .default({ enabled: false, format: 'opus', bitRate: 128 }),
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
      transcodeLossless: { enabled: false, format: 'opus', bitRate: 128 },
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
    })
    .default({
      ytdlp: { enabled: true, binaryPath: 'yt-dlp', format: 'bestaudio', extraArgs: [] },
      spotdl: { enabled: true, binaryPath: 'spotdl' },
      archive: { enabled: true, preferredFormats: ['MP3', 'FLAC'] },
    }),

  jwt: z.object({
    secret: z.string().min(32, 'JWT secret must be at least 32 characters'),
    expiresIn: z.string().default('24h'),
  }),
});

export type NicotinDConfig = z.infer<typeof NicotinDConfigSchema>;
