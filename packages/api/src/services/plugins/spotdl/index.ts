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
  private activeRuns = new Map<string, RunningAcquire>();
  // Injectable spawner — tests pass a fake (no process-global module mock).
  private spawn?: typeof nodeSpawn;

  constructor(config: SpotdlPluginConfig, deps: { spawn?: typeof nodeSpawn } = {}) {
    this.cfg = config;
    this.spawn = deps.spawn;
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
    ];
    // Only pass cookies when the file actually exists — a configured-but-absent
    // path must not break downloads (spotdl errors on a missing cookie file).
    if (this.cfg.cookiesFile && existsSync(this.cfg.cookiesFile)) {
      args.push('--cookie-file', this.cfg.cookiesFile);
    }
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
    });
    this.activeRuns.set(jobId, run);
    try {
      return await run.done;
    } finally {
      this.activeRuns.delete(jobId);
    }
  }
}
