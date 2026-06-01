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
      // Drop an incoming MP3 when a FLAC of the same track is already in the
      // album folder (avoids mixed MP3+FLAC duplicate albums). Opt-in.
      preferFlacSkipMp3: z.boolean().default(false),
    })
    .default({
      autoRetryEnabled: true,
      retryMaxAttempts: 3,
      retryIntervalMs: 15_000,
      retryCooldownMs: 60_000,
      fallbackMaxAttempts: 5,
      preferFlacSkipMp3: false,
    }),

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

  navidrome: z.object({
    url: z.string().url().default('http://localhost:4533'),
    port: z.number().default(4533),
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

  jwt: z.object({
    secret: z.string().min(32, 'JWT secret must be at least 32 characters'),
    expiresIn: z.string().default('24h'),
  }),
});

export type NicotinDConfig = z.infer<typeof NicotinDConfigSchema>;
