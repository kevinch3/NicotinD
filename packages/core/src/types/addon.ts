import { z } from 'zod';
import {
  validatePluginManifest,
  type PluginCapability,
  type PluginCompliance,
  type PluginConfigField,
  type PluginKind,
  type PluginManifest,
} from '../plugin/manifest.js';

/**
 * Acquisition addon protocol v1 (docs/acquisition-addon-protocol.md).
 *
 * An addon is an out-of-process acquisition source speaking HTTP under
 * `/addon/v1/*`. Its manifest is the remote counterpart of `PluginManifest`:
 * fetched from the addon at registration time, validated here, and adapted
 * into the in-process plugin kernel by `RemoteAddonPlugin` (packages/api).
 */

/** The protocol version this core speaks. Addons within the same major work. */
export const ADDON_PROTOCOL_VERSION = '1.0.0';

/** True when the addon's declared protocol version is one this core supports. */
export function addonProtocolSupported(version: string): boolean {
  const m = /^(\d+)\.\d+\.\d+$/.exec(version);
  return m !== null && Number(m[1]) === 1;
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
}

export interface AddonAlbumSearchResponse {
  candidates: AddonAlbumCandidate[];
  /** The literal source queries fired (debug display — the hunt modal shows these). */
  queries: string[];
  skewNeeded: boolean;
}

/* ————— Jobs ————— */

/** `url` is reserved for resolver-shaped addons (phase 2+ of the migration). */
export type AddonJobIntent = 'album' | 'tracks' | 'browse-grab';

export interface AddonJobRequest {
  intent: AddonJobIntent;
  artist?: string;
  album?: string;
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
  intent: z.enum(['album', 'tracks', 'browse-grab']),
  artist: z.string().optional(),
  album: z.string().optional(),
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
