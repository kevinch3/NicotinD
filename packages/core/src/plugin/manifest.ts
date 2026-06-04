import type { ZodTypeAny } from 'zod';

/**
 * Plugin kinds. `acquisition` plugins bring music into the library (slskd,
 * yt-dlp, …); `connectivity` plugins manage how the server is reached
 * (tailscale/wireguard — scaffolded, none shipped yet). The kernel
 * (registry/host/UI) is kind-agnostic; each kind defines its own capability
 * contracts in `./capabilities.ts`.
 */
export type PluginKind = 'acquisition' | 'connectivity';

/** Capabilities an acquisition plugin may declare + implement. */
export type AcquisitionCapability = 'search' | 'browse' | 'resolve' | 'download';

/** Capabilities a connectivity plugin may declare + implement. */
export type ConnectivityCapabilityName = 'connectivity';

export type PluginCapability = AcquisitionCapability | ConnectivityCapabilityName;

/** Legal/compliance metadata surfaced to the admin before enabling. */
export interface PluginCompliance {
  /** Shown in the enable dialog; the admin must acknowledge it. */
  disclaimer: string;
  /** When true the registry records consent (user + timestamp) on enable. */
  requiresConsent: boolean;
}

/** Runtime requirements the host checks for `isAvailable()`. */
export interface PluginRequirements {
  /** Executables that must resolve on PATH (or at a configured path). */
  binaries?: string[];
}

/**
 * Declarative description of a plugin. The manifest is static (no I/O) so the
 * registry can list + reason about plugins without instantiating them.
 */
export interface PluginManifest {
  /** Stable identifier, e.g. 'slskd' | 'ytdlp' | 'spotdl'. */
  id: string;
  /** Human-readable name for the UI. */
  name: string;
  description: string;
  kind: PluginKind;
  /** The subset of its kind's capabilities this plugin actually provides. */
  capabilities: PluginCapability[];
  /** Validates + (later) renders the plugin's config form. Server-side only. */
  configSchema?: ZodTypeAny;
  requirements?: PluginRequirements;
  compliance?: PluginCompliance;
  /**
   * Acquisition plugins are always opt-in (false) for the compliance posture —
   * the registry exposes zero acquisition capability until an admin enables one.
   */
  defaultEnabled: boolean;
}

const ACQUISITION_CAPS: AcquisitionCapability[] = ['search', 'browse', 'resolve', 'download'];

/**
 * Validate a manifest's shape + kind/capability coherence. Returns a list of
 * human-readable problems (empty = valid). Pure — safe to run at registration.
 */
export function validatePluginManifest(m: PluginManifest): string[] {
  const errors: string[] = [];
  if (!m.id || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) {
    errors.push(`invalid plugin id "${m.id}" (expected kebab-case)`);
  }
  if (!m.name) errors.push(`plugin "${m.id}" is missing a name`);
  if (m.kind !== 'acquisition' && m.kind !== 'connectivity') {
    errors.push(`plugin "${m.id}" has unknown kind "${m.kind}"`);
  }
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    errors.push(`plugin "${m.id}" declares no capabilities`);
  } else {
    for (const cap of m.capabilities) {
      const ok =
        m.kind === 'acquisition'
          ? (ACQUISITION_CAPS as string[]).includes(cap)
          : cap === 'connectivity';
      if (!ok) errors.push(`plugin "${m.id}" declares capability "${cap}" invalid for kind "${m.kind}"`);
    }
  }
  if (m.kind === 'acquisition' && m.defaultEnabled) {
    errors.push(`acquisition plugin "${m.id}" must not be defaultEnabled (opt-in only)`);
  }
  return errors;
}

/**
 * Public, serializable view of a plugin for the UI/API — the manifest minus the
 * server-only `configSchema`, plus live registry state. Returned by GET /api/plugins.
 */
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  capabilities: PluginCapability[];
  requirements?: PluginRequirements;
  compliance?: PluginCompliance;
  /** Admin has turned it on (and consented if required). */
  enabled: boolean;
  /** Requirements satisfied + plugin reports itself ready right now. */
  available: boolean;
  /** Declares a configSchema but has no stored config yet. */
  needsConfig: boolean;
}
