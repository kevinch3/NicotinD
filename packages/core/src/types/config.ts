import { z } from 'zod';

export const ServiceModeSchema = z.enum(['embedded', 'external']);
export type ServiceMode = z.infer<typeof ServiceModeSchema>;

export const NicotinDConfigSchema = z.object({
  port: z.number().default(8484),
  dataDir: z.string().default('~/.nicotind'),
  musicDir: z.string().default('~/Music'),
  mode: ServiceModeSchema.default('embedded'),

  soulseek: z.object({
    username: z.string().default(''),
    password: z.string().default(''),
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

  jwt: z.object({
    secret: z.string().min(32, 'JWT secret must be at least 32 characters'),
    expiresIn: z.string().default('24h'),
  }),
});

export type NicotinDConfig = z.infer<typeof NicotinDConfigSchema>;
