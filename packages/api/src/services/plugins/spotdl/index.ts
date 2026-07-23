import type { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Plugin, PluginManifest, PluginHostContext, ResolveCapability } from '@nicotind/core';
import {
  invalidateBinaryCache,
  isBinaryAvailable,
  runAcquireProcess,
  parseSpotdlProgress,
  type RunningAcquire,
} from '../acquire/process.js';
import type { PluginRegistry } from '../registry.js';

export interface SpotdlPluginConfig {
  enabled: boolean;
  binaryPath: string;
  /**
   * Netscape cookies.txt passed as `--cookie-file` when the file exists.
   * YouTube bot-flags server IPs ("Sign in to confirm you're not a bot");
   * account cookies are the only reliable unblock for a flagged IP.
   */
  cookiesFile?: string;
}

const DISCLAIMER =
  'spotdl matches Spotify metadata to audio downloaded from YouTube. You are ' +
  'responsible for complying with the relevant Terms of Service and with ' +
  'copyright law in your jurisdiction.';

/** Read the spotify plugin's stored config, returning the user-supplied
 *  Client ID/Secret pair (or empty strings when absent). Pure read — never
 *  throws, never logs the secret. */
export function readSpotifyCredentials(registry: PluginRegistry): {
  clientId: string;
  clientSecret: string;
} {
  const cfg = registry.getConfig('spotify');
  const clientId = typeof cfg.clientId === 'string' ? cfg.clientId : '';
  const clientSecret = typeof cfg.clientSecret === 'string' ? cfg.clientSecret : '';
  return { clientId, clientSecret };
}

/** Build the env-var layer spotDL needs to use the user's Spotify credentials.
 *  Returns `null` when the creds aren't configured — callers omit the layer
 *  entirely so spotDL falls back to its built-in shared client. */
export function spotifyEnvFor(registry: PluginRegistry): NodeJS.ProcessEnv | null {
  const { clientId, clientSecret } = readSpotifyCredentials(registry);
  if (!clientId.trim() || !clientSecret.trim()) return null;
  // spotDL uses spotipy under the hood, which reads these env vars. Forwarding
  // them raises spotDL's Spotify rate limits (vs. the built-in shared client)
  // so metadata lookups return faster and fall back less often.
  return { SPOTIPY_CLIENT_ID: clientId, SPOTIPY_CLIENT_SECRET: clientSecret };
}

/** Acquisition plugin that pulls audio from Spotify URLs via spotdl. */
export class SpotdlPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'spotdl',
    name: 'spotDL',
    description: 'Download audio from Spotify track/album/playlist URLs by URL.',
    kind: 'acquisition',
    capabilities: ['resolve'],
    requirements: { binaries: ['spotdl'] },
    configSchema: z
      .object({ binaryPath: z.string().optional(), cookiesFile: z.string().optional() })
      .partial(),
    configFields: [
      {
        key: 'binaryPath',
        label: 'spotdl binary path',
        type: 'text',
        placeholder: 'spotdl',
        help: 'Full path to the spotdl executable if it is not on PATH (e.g. ~/.local/bin/spotdl).',
      },
    ],
    compliance: { disclaimer: DISCLAIMER, requiresConsent: true },
    defaultEnabled: false,
  };

  private ctx: PluginHostContext | null = null;
  private cfg: SpotdlPluginConfig;
  private registry: PluginRegistry | null;
  private activeRuns = new Map<string, RunningAcquire>();
  // Injectable spawner — tests pass a fake (no process-global module mock).
  private spawn?: typeof nodeSpawn;

  constructor(
    config: SpotdlPluginConfig,
    deps: { spawn?: typeof nodeSpawn; registry?: PluginRegistry } = {},
  ) {
    this.cfg = config;
    this.spawn = deps.spawn;
    this.registry = deps.registry ?? null;
  }

  readonly resolve: ResolveCapability = {
    canHandle: (url: string) => url.includes('spotify.com'),
    resolve: (url, jobId) => this.run(url, jobId),
    cancel: (jobId) => this.activeRuns.get(jobId)?.cancel() ?? false,
  };

  async init(ctx: PluginHostContext): Promise<void> {
    this.ctx = ctx;
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<SpotdlPluginConfig>) };
    // Re-probe on (re)init: a binary installed or a path reconfigured while
    // the app runs must not stay "unavailable" behind a stale cached negative.
    invalidateBinaryCache(this.cfg.binaryPath);
  }

  async isAvailable(): Promise<boolean> {
    return this.cfg.enabled && isBinaryAvailable(this.cfg.binaryPath);
  }

  /**
   * Build the env-var layer to merge into the spawn env. The Spotify plugin's
   * stored client id/secret are forwarded as SPOTIPY_CLIENT_ID /
   * SPOTIPY_CLIENT_SECRET so spotDL's metadata calls use a user-owned rate
   * limit (vs. its built-in shared client). Returns `null` when neither value
   * is set — callers omit the layer entirely so spotDL stays on the default.
   *
   * Reads the registry live (no cache) so an admin editing the Spotify card
   * takes effect on the next `run()` without needing to re-init the plugin.
   *
   * Public because the interesting failure mode is the **wiring**: when this
   * plugin is constructed without its registry the forwarding silently becomes
   * a no-op, and every test of `spotifyEnvFor` still passes. `builtin.test.ts`
   * asserts against this on the instance the real registration built.
   */
  spotifyEnv(): NodeJS.ProcessEnv | null {
    return this.registry ? spotifyEnvFor(this.registry) : null;
  }

  private async run(url: string, jobId: string): Promise<string[]> {
    if (!this.ctx) throw new Error('spotdl plugin not initialized');
    const stagingDir = this.ctx.allocStagingDir(jobId);
    const args = [
      'download',
      url,
      '--output',
      join(stagingDir, '{artist}', '{album}', '{title}.{output-ext}'),
      // A retry resumes into this same staging dir (AcquireWatcher.retryJob);
      // explicit skip means already-downloaded tracks aren't re-fetched or
      // treated as an error, regardless of spotdl's version-dependent default.
      '--overwrite',
      'skip',
      // Better download quality: with no --bitrate, spotdl re-encodes every
      // track to auto-bitrate MP3 — a lossy→lossy transcode of an already-lossy
      // YouTube stream, discarding audio. `disable` skips ffmpeg's bitrate
      // conversion and copies the source stream through untouched, so we keep
      // YouTube Music's native ~256 kbps AAC (Opus for plain YouTube). The
      // download-pipeline's own lossless→Opus standardization then applies at a
      // known, controlled bitrate instead of stacking two lossy encodes.
      '--bitrate',
      'disable',
    ];
    // Only pass cookies when the file actually exists — a configured-but-absent
    // path must not break downloads (spotdl errors on a missing cookie file).
    if (this.cfg.cookiesFile && existsSync(this.cfg.cookiesFile)) {
      args.push('--cookie-file', this.cfg.cookiesFile);
    }
    const spotifyEnv = this.spotifyEnv();
    const run = runAcquireProcess({
      binaryPath: this.cfg.binaryPath,
      args,
      stagingDir,
      parseProgress: parseSpotdlProgress,
      onProgress: (p) => this.ctx!.emitProgress(jobId, p),
      onLabel: (label) => this.ctx!.emitLabel(jobId, label),
      // spotdl only logs titles (`Downloaded "Artist - Title"`) — no filename.
      // Forward the event as-is; the host stores a title-only track row and
      // the playlist resolver falls back to title matching for these.
      onTrack: (event) => this.ctx!.emitTrack(jobId, event),
      spawn: this.spawn,
      // The Spotify creds override anything `acquireEnv` already laid down;
      // when not configured, we pass `undefined` and the runner falls back to
      // its default env (PATH augmentation only).
      extraEnv: spotifyEnv ?? undefined,
    });
    this.activeRuns.set(jobId, run);
    try {
      return await run.done;
    } finally {
      this.activeRuns.delete(jobId);
    }
  }
}
