/**
 * Shared fingerprint-identify helpers over the `identify` plugin capability
 * (AcoustID). Lifted out of routes/download-review.ts so the library
 * track-info identify routes and the review inbox share one implementation.
 */
import type { IdentifyCapability, IdentifyOutcome } from '@nicotind/core';
import type { PluginRegistry } from './plugins/registry.js';
import { normalizeTagValue, type AudioTags } from './audio-tags.js';

/** The curator-approved suggestion echoed back by the apply route. */
export interface IdentifyApplyBody {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNumber?: number;
  acoustId?: string;
  recordingId?: string;
  releaseId?: string;
}

/**
 * Map a curator-approved apply body onto the AudioTags to write to the file.
 * Empty/placeholder strings and out-of-range numbers are ignored, never
 * written — an apply can only add/replace tags, not clear them, so a thin
 * AcoustID match can't wipe an existing tag. Returns null when nothing
 * survives (the route 400s). MBID fields map onto their tag names:
 * acoustId → acoustIdId, recordingId → mbRecordingId, releaseId →
 * mbReleaseId (the organizer's persist set — see library-organizer.ts).
 */
export function buildIdentifyApplyTags(body: IdentifyApplyBody): AudioTags | null {
  const tags: AudioTags = {};
  const strings: Array<
    [
      'title' | 'artist' | 'album' | 'albumArtist' | 'acoustIdId' | 'mbRecordingId' | 'mbReleaseId',
      string | undefined,
    ]
  > = [
    ['title', body.title],
    ['artist', body.artist],
    ['album', body.album],
    ['albumArtist', body.albumArtist],
    ['acoustIdId', body.acoustId],
    ['mbRecordingId', body.recordingId],
    ['mbReleaseId', body.releaseId],
  ];
  for (const [key, raw] of strings) {
    const value = normalizeTagValue(raw);
    if (value !== undefined) tags[key] = value;
  }
  if (Number.isInteger(body.year) && body.year! >= 1900 && body.year! <= 2100) {
    tags.year = body.year;
  }
  if (Number.isInteger(body.trackNumber) && body.trackNumber! >= 1) {
    tags.trackNumber = body.trackNumber;
  }
  return Object.keys(tags).length > 0 ? tags : null;
}

export function identifyPlugin(
  plugins: PluginRegistry | null | undefined,
): IdentifyCapability | null {
  const hits = plugins?.getEnabledWithCapability('identify') ?? [];
  const p = hits[0] as { identify?: IdentifyCapability } | undefined;
  return p?.identify ?? null;
}

/**
 * One identify attempt, always as a typed outcome (issue #414). Falls back to
 * mapping a plain `identifyTrack` null onto `no-match` for a plugin that
 * doesn't implement the detailed variant.
 */
export async function identifyOne(
  plugin: IdentifyCapability,
  abs: string,
): Promise<IdentifyOutcome> {
  if (plugin.identifyTrackDetailed) return plugin.identifyTrackDetailed(abs);
  const result = await plugin.identifyTrack(abs);
  return result ? { kind: 'match', result } : { kind: 'no-match' };
}

/**
 * Cheap "can the user hit Identify" check for the `identify` capability
 * (AcoustID). Deliberately does NOT call `plugin.isAvailable()` — that spawns
 * the `fpcalc` binary as a probe subprocess, which is fine for the Extensions
 * status pill (polled rarely) but too expensive to run on every candidate
 * gather. "Enabled + has an API key configured" is a good enough proxy: the
 * binary check happens for real when the user actually clicks Identify.
 */
export function computeIdentifyAvailable(plugins: PluginRegistry | null | undefined): boolean {
  if (!plugins) return false;
  return plugins.getEnabledWithCapability('identify').some((p) => {
    const cfg = plugins.getConfig(p.manifest.id) as { apiKey?: string };
    return Boolean(cfg.apiKey);
  });
}
