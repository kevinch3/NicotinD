import { Hono } from 'hono';
import type { NicotinDConfig } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import {
  getStreamingSettings,
  setStreamingSettings,
  type StreamingSettings,
} from '../services/streaming-settings.js';
import { ffmpegAvailable } from '../services/transcode.js';

export function settingsRoutes(config: NicotinDConfig) {
  const app = new Hono<AuthEnv>();

  // GET /api/settings/streaming — current transcoding preferences + ffmpeg status
  app.get('/streaming', (c) => {
    const settings = getStreamingSettings(getDatabase());
    return c.json({ ...settings, ffmpegAvailable: ffmpegAvailable() });
  });

  // GET /api/settings/downloads — download-pipeline preferences the UI needs to
  // render an accurate acquisition-flow hint. Currently just the lossless→Opus
  // standardization (env/YAML-configured, captured into LibraryOrganizer at boot),
  // exposed read-only so the search/acquire UI can tell the user a FLAC pick will
  // be stored as Opus — but only when it's actually on and ffmpeg is present.
  // Any authenticated user (the hint shows in the acquire flow); no secrets here.
  app.get('/downloads', (c) => {
    const t = config.downloads.transcodeLossless;
    return c.json({
      transcodeLossless: { enabled: t.enabled, format: t.format, bitRate: t.bitRate },
      ffmpegAvailable: ffmpegAvailable(),
    });
  });

  // PUT /api/settings/streaming — update transcoding preferences (admin)
  app.put('/streaming', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json(
        { error: 'Only administrators can change streaming settings', code: 'FORBIDDEN' },
        403,
      );
    }
    const body = await c.req.json<Partial<StreamingSettings>>();
    const patch: Partial<StreamingSettings> = {};
    if (typeof body.transcodeEnabled === 'boolean') patch.transcodeEnabled = body.transcodeEnabled;
    if (typeof body.forceTranscode === 'boolean') patch.forceTranscode = body.forceTranscode;
    if (body.format === 'mp3' || body.format === 'opus' || body.format === 'aac') {
      patch.format = body.format;
    }
    if (typeof body.maxBitRate === 'number' && body.maxBitRate > 0 && body.maxBitRate <= 512) {
      patch.maxBitRate = Math.round(body.maxBitRate);
    }
    const next = setStreamingSettings(getDatabase(), patch);
    return c.json({ ...next, ffmpegAvailable: ffmpegAvailable() });
  });

  return app;
}
