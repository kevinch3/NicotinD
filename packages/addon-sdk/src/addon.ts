import { z } from 'zod';
import {
  validatePluginManifest,
  type PluginCapability,
  type PluginCompliance,
  type PluginConfigField,
  type PluginKind,
  type PluginManifest,
} from './manifest.js';

/**
 * Acquisition addon protocol v1 (docs/acquisition-addon-protocol.md).
 *
 * An addon is an out-of-process acquisition source speaking HTTP under
 * `/addon/v1/*`. Its manifest is the remote counterpart of `PluginManifest`:
 * fetched from the addon at registration time, validated here, and adapted
 * into the in-process plugin kernel by `RemoteAddonPlugin` (packages/api).
 */

/** The protocol version this core speaks. Addons within the same major work. */
export const ADDON_PROTOCOL_VERSION = '1.1.0';

/**
 * Protocol majors this core speaks. Additive-only within a major (§2 policy),
 * so any 1.x addon is compatible; a future core widens this set to accept an
 * older major during a deprecation window.
 */
export const SUPPORTED_PROTOCOL_MAJORS: ReadonlySet<number> = new Set([1]);

/** True when the addon's declared protocol version is one this core supports. */
export function addonProtocolSupported(version: string): boolean {
  const m = /^(\d+)\.\d+\.\d+$/.exec(version);
  return m !== null && SUPPORTED_PROTOCOL_MAJORS.has(Number(m[1]));
}

/**
 * Capability negotiation (§2): the active set is `{declared} ∩ {implemented}`.
 * A declared capability core does not recognize is **ignored, not an error** —
 * forward compatibility, so a newer addon still works for what today's core
 * knows. A caller registering an addon rejects an empty `active` set ("nothing
 * this core can use"). `ignored` is surfaced for logging only.
 */
export function negotiateCapabilities(
  declared: readonly string[],
  implemented: ReadonlySet<string>,
): { active: string[]; ignored: string[] } {
  const active: string[] = [];
  const ignored: string[] = [];
  for (const cap of declared) {
    (implemented.has(cap) ? active : ignored).push(cap);
  }
  return { active, ignored };
}

/** One typed row of the addon's `GET status` panel. */
export interface AddonStatusRow {
  key: string;
  label: string;
  value: string;
}

/** `GET health` response — mirrors the analysis-sidecar health shape. */
export interface AddonHealth {
  ok: boolean;
  ready: boolean;
  detail?: string;
}

/** A status field the addon promises to report (manifest-declared). */
export interface AddonStatusField {
  key: string;
  label: string;
}

/** `GET manifest` response — the addon's self-description. */
export interface AddonManifest {
  id: string;
  name: string;
  description: string;
  /** The addon software's own version (informational). */
  version: string;
  /** Protocol version the addon implements; must satisfy `addonProtocolSupported`. */
  protocolVersion: string;
  kind: PluginKind;
  capabilities: PluginCapability[];
  configFields?: PluginConfigField[];
  statusFields?: AddonStatusField[];
  compliance?: PluginCompliance;
  /** For resolve-capable addons: regexes of URLs the addon can handle. */
  urlPatterns?: string[];
  /**
   * URL-routing priority (default 0): when several enabled resolve addons match
   * a URL, the highest priority wins. A catch-all addon (e.g. yt-dlp, matching
   * `^https?://`) declares a negative priority so specific addons beat it.
   */
  priority?: number;
}

const configFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'password']),
  placeholder: z.string().optional(),
  help: z.string().optional(),
});

/** Parses an untrusted manifest response body. Shape only — coherence is
 *  `validateAddonManifest`'s job so its errors stay human-readable. */
export const addonManifestSchema: z.ZodType<AddonManifest> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  protocolVersion: z.string().min(1),
  kind: z.enum(['acquisition', 'metadata', 'connectivity']),
  capabilities: z.array(z.string()).min(1) as unknown as z.ZodType<PluginCapability[]>,
  configFields: z.array(configFieldSchema).optional(),
  statusFields: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).optional(),
  compliance: z.object({ disclaimer: z.string(), requiresConsent: z.boolean() }).optional(),
  urlPatterns: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
}) as z.ZodType<AddonManifest>;

/* ————— Search (blended lane) ————— */

export interface AddonSearchRequest {
  query: string;
  /** Soft wait budget for the source's own search round-trip. */
  waitMs?: number;
}

export const addonSearchRequestSchema = z.object({
  query: z.string().min(1),
  waitMs: z.number().int().positive().max(120_000).optional(),
});

export interface AddonSearchResultFile {
  filename: string;
  size: number;
  bitRateKbps?: number;
}

/** One source-neutral result row for the blended search lane. */
export interface AddonSearchResult {
  kind: 'song' | 'folder';
  title: string;
  username: string;
  directory?: string;
  filename?: string;
  size?: number;
  bitRateKbps?: number;
  audioFormat?: string;
  files?: AddonSearchResultFile[];
  /** Peer health (network sources) — the host's ranking inputs. */
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
}

export interface AddonSearchResponse {
  results: AddonSearchResult[];
  complete: boolean;
}

/* ————— Album hunt lane ————— */

export interface AddonTrackRef {
  title: string;
}

export interface AddonAlbumSearchRequest {
  artist: string;
  album: string;
  canonicalTracks: AddonTrackRef[];
  /** Force the skew pass even when the base pass looks complete. */
  skew?: boolean;
}

export const addonAlbumSearchRequestSchema = z.object({
  artist: z.string().min(1),
  album: z.string().min(1),
  canonicalTracks: z.array(z.object({ title: z.string() })),
  skew: z.boolean().optional(),
});

export interface AddonAlbumCandidate {
  /** Opaque short-lived token — pass back in a job request to pick this folder. */
  candidateRef: string;
  username: string;
  directory: string;
  matchedTracks: number;
  totalTracks: number;
  matchPct: number;
  format: string;
  estimatedSizeMb: number;
  isLive: boolean;
  files: AddonSearchResultFile[];
  /** Peer health — the host's candidate-display/ranking inputs. */
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
}

export interface AddonAlbumSearchResponse {
  candidates: AddonAlbumCandidate[];
  /** The literal source queries fired (debug display — the hunt modal shows these). */
  queries: string[];
  skewNeeded: boolean;
  /**
   * The source throttled the search burst (e.g. slskd 429s a slew of concurrent
   * searches) and some queries were dropped after retries, so the hunt may be
   * incomplete. The UI treats an empty/partial result as "still searching — keep
   * trying" rather than a genuine "no results". Additive + optional.
   */
  rateLimited?: boolean;
}

/* ————— Jobs ————— */

/** `url` is the resolver-shaped intent (yt-dlp/spotdl/archive URL acquisition). */
export type AddonJobIntent = 'album' | 'tracks' | 'browse-grab' | 'url';

export interface AddonJobRequest {
  intent: AddonJobIntent;
  artist?: string;
  album?: string;
  /** url: the URL to resolve into downloadable audio. */
  url?: string;
  /** url: playlist/album/single classification hint (source-specific). */
  as?: 'playlist' | 'album' | 'single';
  /** Full canonical tracklist — what candidates are scored against. */
  canonicalTracks?: AddonTrackRef[];
  /** Missing-on-disk subset — what actually gets acquired. Defaults to all. */
  wantedTracks?: AddonTrackRef[];
  /** album: acquire this previously-returned candidate instead of auto-picking. */
  candidateRef?: string;
  /** album: auto-pick threshold (matchPct floor). */
  minMatchPct?: number;
  /** tracks: bare titles to hunt individually. */
  titles?: string[];
  /** browse-grab: explicit peer files. */
  username?: string;
  files?: { filename: string; size: number }[];
}

export const addonJobRequestSchema = z.object({
  intent: z.enum(['album', 'tracks', 'browse-grab', 'url']),
  artist: z.string().optional(),
  album: z.string().optional(),
  url: z.string().optional(),
  as: z.enum(['playlist', 'album', 'single']).optional(),
  canonicalTracks: z.array(z.object({ title: z.string() })).optional(),
  wantedTracks: z.array(z.object({ title: z.string() })).optional(),
  candidateRef: z.string().optional(),
  minMatchPct: z.number().min(0).max(100).optional(),
  titles: z.array(z.string()).optional(),
  username: z.string().optional(),
  files: z.array(z.object({ filename: z.string(), size: z.number() })).optional(),
});

export type AddonJobState = 'active' | 'done' | 'partial' | 'failed' | 'cancelled';
export type AddonJobItemState = 'queued' | 'downloading' | 'completed' | 'failed' | 'unavailable';

export interface AddonJobItem {
  /**
   * Stable across fallback repoints: an addon-internal re-pull from another
   * peer flips `username`/`filename` on the SAME item, so the host's mirror
   * upsert reproduces repoint semantics without knowing fallback exists.
   */
  itemId: string;
  title: string | null;
  username: string;
  filename: string;
  size: number;
  bitRateKbps?: number;
  audioFormat?: string;
  state: AddonJobItemState;
  bytesTransferred?: number;
  /** File bytes are downloadable via GET jobs/:id/files/:itemId. */
  fileReady: boolean;
  updatedAt: number;
}

export interface AddonJob {
  id: string;
  intent: AddonJobIntent;
  artist: string | null;
  album: string | null;
  /**
   * Human display name for this job — the playlist name, the video title, the
   * release name. **Display-only, never filing metadata**: `album` flows into
   * `acquisition_jobs.album_title`, which mints an album id and tells the
   * organizer where the files go, so putting "Summer Mix 2024" there would
   * create a phantom album and mis-file every track in it. That is why this is
   * its own field rather than an overload of `album`.
   *
   * Added in protocol **1.1**, additive and optional: a 1.0 addon simply omits
   * it and the host degrades through its own title chain (destination album →
   * source folder → the pasted URL → the source label). Same major, so
   * `addonProtocolSupported` keeps accepting 1.0 addons unchanged.
   */
  title?: string | null;
  state: AddonJobState;
  error: string | null;
  items: AddonJobItem[];
  createdAt: number;
  updatedAt: number;
}

/** Adapt an addon manifest to the plugin-manifest shape the kernel validates. */
export function pluginManifestFromAddon(m: AddonManifest): PluginManifest {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    kind: m.kind,
    capabilities: m.capabilities,
    configFields: m.configFields,
    compliance: m.compliance,
    // Remote sources are always opt-in — the compliance posture, and for
    // acquisition kinds also what validatePluginManifest enforces.
    defaultEnabled: false,
  };
}

/** Validate coherence of an addon manifest (empty list = valid). */
export function validateAddonManifest(m: AddonManifest): string[] {
  const errors = validatePluginManifest(pluginManifestFromAddon(m));
  if (!addonProtocolSupported(m.protocolVersion)) {
    errors.push(
      `addon "${m.id}" speaks protocol ${m.protocolVersion}; this server supports ${ADDON_PROTOCOL_VERSION} (same major)`,
    );
  }
  return errors;
}
