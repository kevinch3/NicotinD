import { z } from 'zod';
import type { Plugin, PluginManifest, PluginHostContext, IdentifyCapability } from '@nicotind/core';
import { AcoustIdLookup, type AcoustIdLookupDeps } from '../../acoustid-lookup.js';
import { invalidateBinaryCache, isBinaryAvailable } from '../acquire/process.js';

export interface AcoustidPluginConfig {
  apiKey: string;
  binaryPath: string;
}

const DISCLAIMER =
  'AcoustID identifies tracks from an audio fingerprint (chromaprint) — the ' +
  'rescue path when tags are missing or wrong. Requires a free API key from ' +
  'acoustid.org/new-application and the fpcalc binary (libchromaprint-tools).';

/**
 * Metadata plugin promoting the existing `AcoustIdLookup` engine (previously
 * wired only into `LibraryOrganizer`'s tags-missing fallback) into an
 * `identify` capability the download-inbox triage flow (issue #411) can call
 * directly on an arbitrary file, before the file has ever been organized or
 * tagged. The engine itself is unchanged; this is the manifest/config/
 * availability shell around it, modeled on Discogs/yt-dlp.
 */
export class AcoustidPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'acoustid',
    name: 'AcoustID',
    description:
      'Identifies tracks from their audio fingerprint (chromaprint) — the rescue ' +
      'path when tags are garbage or missing.',
    kind: 'metadata',
    capabilities: ['identify'],
    requirements: { binaries: ['fpcalc'] },
    configSchema: z
      .object({
        apiKey: z.string().optional(),
        binaryPath: z.string().optional(),
      })
      .partial(),
    configFields: [
      {
        key: 'apiKey',
        label: 'AcoustID API key',
        type: 'password',
        help: 'Free key from acoustid.org/new-application',
      },
      {
        key: 'binaryPath',
        label: 'fpcalc binary path',
        type: 'text',
        placeholder: 'fpcalc',
        help: 'Full path to the fpcalc executable if it is not on PATH.',
      },
    ],
    compliance: { disclaimer: DISCLAIMER, requiresConsent: false },
    defaultEnabled: false,
  };

  private cfg: AcoustidPluginConfig;
  private readonly deps: AcoustIdLookupDeps;
  private lookup: AcoustIdLookup | null = null;

  constructor(config: Partial<AcoustidPluginConfig> = {}, deps: AcoustIdLookupDeps = {}) {
    this.cfg = { apiKey: config.apiKey ?? '', binaryPath: config.binaryPath ?? 'fpcalc' };
    this.deps = deps;
    this.rebuild();
  }

  readonly identify: IdentifyCapability = {
    identifyTrack: (absPath) => this.lookup?.lookup(absPath) ?? Promise.resolve(null),
    // Issue #414: the "why" variant. An unconfigured plugin reports
    // source-error rather than no-match — nothing was asked of AcoustID.
    identifyTrackDetailed: (absPath) =>
      this.lookup?.identify(absPath) ??
      Promise.resolve({ kind: 'source-error', detail: 'AcoustID is not configured' } as const),
  };

  async init(ctx: PluginHostContext): Promise<void> {
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<AcoustidPluginConfig>) };
    // Re-probe on (re)init: a binary installed or a path reconfigured while
    // the app runs must not stay "unavailable" behind a stale cached negative.
    invalidateBinaryCache(this.cfg.binaryPath);
    this.rebuild();
  }

  async isAvailable(): Promise<boolean> {
    // chromaprint's fpcalc uses a single-dash `-version` flag, not `--version`.
    return Boolean(this.cfg.apiKey) && isBinaryAvailable(this.cfg.binaryPath, ['-version']);
  }

  /** Test/regression seam: was the API key actually threaded through from
   *  wherever this instance was constructed (registerBuiltinPlugins seeds it
   *  from the legacy secrets.json key)? Avoids `isAvailable()`, which also
   *  depends on the real fpcalc binary being present. */
  hasApiKey(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  private rebuild(): void {
    this.lookup = this.cfg.apiKey
      ? new AcoustIdLookup(this.cfg.apiKey, this.cfg.binaryPath, this.deps)
      : null;
  }
}
