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
