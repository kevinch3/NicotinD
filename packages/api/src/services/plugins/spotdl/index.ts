import type { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import type {
  Plugin,
  PluginManifest,
  PluginHostContext,
  ResolveCapability,
} from '@nicotind/core';
import { isBinaryAvailable, runAcquireProcess, type RunningAcquire } from '../acquire/process.js';

export interface SpotdlPluginConfig {
  enabled: boolean;
  binaryPath: string;
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
  }

  async isAvailable(): Promise<boolean> {
    return this.cfg.enabled && isBinaryAvailable(this.cfg.binaryPath);
  }

  private async run(url: string, jobId: string): Promise<string[]> {
    if (!this.ctx) throw new Error('spotdl plugin not initialized');
    const stagingDir = this.ctx.allocStagingDir(jobId);
    const run = runAcquireProcess({
      binaryPath: this.cfg.binaryPath,
      args: [
        'download',
        url,
        '--output',
        join(stagingDir, '{artist}', '{album}', '{title}.{output-ext}'),
      ],
      stagingDir,
      onProgress: (p) => this.ctx!.emitProgress(jobId, p),
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
