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
import {
  getRadioSettings,
  isValidQueueTarget,
  setRadioSettings,
  type RadioSettings,
} from '../services/radio-settings.js';
import { computeGenreCentroids, genreCentroidsStatus } from '../services/genre-centroids.js';
import { getDownloadsSettings } from '../services/downloads-settings.js';
import { recordAudit } from '../services/audit-log.js';
import {
  formatChangeImpact,
  getLibraryFormatSettings,
  effectiveLadder,
  TARGET_LUFS_MIN,
  TARGET_LUFS_MAX,
  LibraryFormatSettingsSchema,
  setLibraryFormatSettings,
} from '../services/library-format-settings.js';
import { LIBRARY_FORMATS } from '../services/library-format.js';
import { LADDERS, ladderToJson } from '../services/transcode-bitrate.js';

export function settingsRoutes(config: NicotinDConfig) {
  const app = new Hono<AuthEnv>();

  // GET /api/settings/streaming — current transcoding preferences + ffmpeg status
  app.get('/streaming', (c) => {
    const settings = getStreamingSettings(getDatabase());
    return c.json({ ...settings, ffmpegAvailable: ffmpegAvailable() });
  });

  // GET /api/settings/downloads — download-pipeline preferences the UI needs to
  // render an accurate acquisition-flow hint. Currently just the lossless→Opus
  // standardization, exposed read-only so the search/acquire UI can tell the user
  // a FLAC pick will be stored as Opus — but only when it's actually on and
  // ffmpeg is present.
  //
  // The EFFECTIVE value, not the configured one: an operator's explicit choice
  // lives in `app_settings.downloads` and overrides the env/YAML default, which
  // on prod is unsettable at runtime because the image carries no config file.
  // Any authenticated user (the hint shows in the acquire flow); no secrets here.
  app.get('/downloads', (c) => {
    const { transcodeLossless: t } = getDownloadsSettings(
      getDatabase(),
      config.downloads.transcodeLossless,
    );
    return c.json({
      transcodeLossless: {
        enabled: t.enabled,
        format: config.downloads.transcodeLossless.format,
        bitRate: t.bitRate,
      },
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

  // GET /api/settings/library-format — what the library is standardized on, the
  // formats available, and what each can actually do. The capabilities ship with
  // the list on purpose: a selector that does not say "this format cannot
  // normalize loudness" is the trap #1256 names, because the capability loss has
  // no symptom afterwards.
  app.get('/library-format', (c) => {
    const db = getDatabase();
    const settings = getLibraryFormatSettings(db);
    return c.json({
      ...settings,
      ffmpegAvailable: ffmpegAvailable(),
      available: Object.values(LIBRARY_FORMATS).map((s) => ({
        id: s.id,
        ext: s.ext,
        // Declared, not inferred from the id: `writeGain: null` IS the
        // capability statement, and the UI renders exactly what the strategy says.
        canNormalizeLoudness: s.writeGain !== null,
        maxEmbeddedPictureBytes: s.maxEmbeddedPictureBytes,
        // What switching to it would cost right now, so the confirmation can
        // quote a real number instead of a warning nobody reads.
        impact: formatChangeImpact(db, s.id),
        // The rates a conversion to it would use, and the measured defaults
        // shown beside them (#1255).
        ladder: ladderToJson(effectiveLadder(settings, s.id)),
        defaultLadder: ladderToJson(LADDERS[s.id]),
        ladderOverridden: settings.ladders[s.id] !== undefined,
      })),
    });
  });

  // PUT /api/settings/library-format — choose the library's target format (admin).
  //
  // Refuses a change that would re-encode existing files unless the caller says
  // `confirm: true`. The setting reads like a preference and is not one: it
  // governs a pass that rewrites files on disk and re-mints every `songId`.
  app.put('/library-format', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json(
        { error: 'Only administrators can change the library format', code: 'FORBIDDEN' },
        403,
      );
    }
    const body = await c.req.json<{
      format?: unknown;
      targetLufs?: unknown;
      // `{ format, ladder }` sets that format's ladder; `ladder: null` restores
      // the measured default (#1255).
      ladder?: { format?: unknown; ladder?: unknown };
      confirm?: unknown;
    }>();
    const db = getDatabase();
    const current = getLibraryFormatSettings(db);
    const ladders: Record<string, unknown> = { ...current.ladders };
    if (body.ladder && typeof body.ladder.format === 'string') {
      if (body.ladder.ladder === null) delete ladders[body.ladder.format];
      else ladders[body.ladder.format] = body.ladder.ladder;
    }
    // Every field may be sent alone; an absent one keeps its current value.
    const parsed = LibraryFormatSettingsSchema.safeParse({
      format: body.format ?? current.format,
      targetLufs: body.targetLufs ?? current.targetLufs,
      ladders,
    });
    if (!parsed.success) {
      const badTarget = parsed.error.issues.some((i) => i.path[0] === 'targetLufs');
      const badLadder = parsed.error.issues.find((i) => i.path[0] === 'ladders');
      if (badLadder) {
        return c.json(
          { error: `Invalid ladder: ${badLadder.message}`, code: 'INVALID_LADDER' },
          400,
        );
      }
      return c.json(
        badTarget
          ? {
              error: `targetLufs must be a number from ${TARGET_LUFS_MIN} to ${TARGET_LUFS_MAX}`,
              code: 'INVALID_TARGET_LUFS',
            }
          : {
              error: `Unknown library format. Available: ${Object.keys(LIBRARY_FORMATS).join(', ')}`,
              code: 'INVALID_FORMAT',
            },
        400,
      );
    }
    const impact = formatChangeImpact(db, parsed.data.format);
    if (parsed.data.format !== current.format && impact.destructive && body.confirm !== true) {
      return c.json(
        {
          error:
            `Changing the library format to ${parsed.data.format} would re-encode ` +
            `${impact.wouldReEncode} song(s) on the next conversion pass, a second lossy ` +
            `generation, and re-mint every one of their ids. Pass confirm: true to accept.`,
          code: 'CONFIRM_REQUIRED',
          impact,
        },
        409,
      );
    }
    const next = setLibraryFormatSettings(db, parsed.data);
    recordAudit(db, user, 'settings.libraryFormat', {
      targetKind: 'setting',
      targetId: 'libraryFormat',
      detail: JSON.stringify({
        from: current.format,
        to: next.format,
        wouldReEncode: impact.wouldReEncode,
        ...(next.targetLufs !== current.targetLufs
          ? { targetLufs: { from: current.targetLufs, to: next.targetLufs } }
          : {}),
        ...(body.ladder ? { ladder: body.ladder } : {}),
      }),
    });
    return c.json({ ...next, impact: formatChangeImpact(db, next.format) });
  });

  // GET /api/settings/radio — the learned-genre-axis opt-in + how much data
  // backs it (docs/genre-affinity.md). Any authenticated user: the Now Playing
  // surface may want to say which genre axis is in force; nothing secret here.
  app.get('/radio', (c) => {
    const db = getDatabase();
    return c.json({ ...getRadioSettings(db), ...genreCentroidsStatus(db) });
  });

  // PUT /api/settings/radio — flip the opt-in (admin). Enabling it on a
  // library that has never built its centroids builds them right here, so the
  // toggle takes effect on the next radio fetch instead of after the daily
  // sweep; the sweep keeps them fresh from then on.
  app.put('/radio', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json(
        { error: 'Only administrators can change radio settings', code: 'FORBIDDEN' },
        403,
      );
    }
    const db = getDatabase();
    const body = await c.req.json<Partial<RadioSettings>>();
    const patch: Partial<RadioSettings> = {};
    if (typeof body.genreAffinity === 'boolean') patch.genreAffinity = body.genreAffinity;
    // The band lives with the store, not here: a second copy of 5..50 is a
    // second thing to forget when the client's depth ceiling moves.
    if (isValidQueueTarget(body.queueTarget)) patch.queueTarget = body.queueTarget;
    const next = setRadioSettings(db, patch);
    if (next.genreAffinity && genreCentroidsStatus(db).centroids === 0) computeGenreCentroids(db);
    return c.json({ ...next, ...genreCentroidsStatus(db) });
  });

  return app;
}
