import type { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Plugin, PluginManifest, PluginHostContext, ResolveCapability } from '@nicotind/core';
import { isBinaryAvailable, runAcquireProcess, type RunningAcquire } from '../acquire/process.js';

export interface YtdlpPluginConfig {
  enabled: boolean;
  binaryPath: string;
  format: 'mp3' | 'opus' | 'bestaudio';
  extraArgs: string[];
  /**
   * Netscape cookies.txt passed as `--cookies` when the file exists.
   * YouTube bot-flags server IPs ("Sign in to confirm you're not a bot");
   * account cookies are the only reliable unblock for a flagged IP.
   */
  cookiesFile?: string;
}

const DISCLAIMER =
  'yt-dlp downloads audio from YouTube and many other sites. You are responsible ' +
  'for complying with each source site’s Terms of Service and with copyright law ' +
  'in your jurisdiction.';

/** Acquisition plugin that pulls audio from URLs via yt-dlp. */
export class YtdlpPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'ytdlp',
    name: 'yt-dlp',
    description: 'Download audio from YouTube and many other sites by URL.',
    kind: 'acquisition',
    capabilities: ['resolve'],
    requirements: { binaries: ['yt-dlp'] },
    configSchema: z
      .object({
        format: z.enum(['mp3', 'opus', 'bestaudio']).optional(),
        extraArgs: z.array(z.string()).optional(),
        cookiesFile: z.string().optional(),
      })
      .partial(),
    compliance: { disclaimer: DISCLAIMER, requiresConsent: true },
    defaultEnabled: false,
  };

  private ctx: PluginHostContext | null = null;
  private cfg: YtdlpPluginConfig;
  private activeRuns = new Map<string, RunningAcquire>();
  // Injectable spawner — tests pass a fake (no process-global module mock).
  private spawn?: typeof nodeSpawn;

  constructor(config: YtdlpPluginConfig, deps: { spawn?: typeof nodeSpawn } = {}) {
    this.cfg = config;
    this.spawn = deps.spawn;
  }

  readonly resolve: ResolveCapability = {
    // yt-dlp is the catch-all backend for everything that isn't Spotify.
    canHandle: (url: string) => !url.includes('spotify.com'),
    resolve: (url, jobId) => this.run(url, jobId),
    cancel: (jobId) => this.activeRuns.get(jobId)?.cancel() ?? false,
  };

  async init(ctx: PluginHostContext): Promise<void> {
    this.ctx = ctx;
    // Admin-set config (from the plugins table) overrides the seeded defaults.
    this.cfg = { ...this.cfg, ...(ctx.config as Partial<YtdlpPluginConfig>) };
  }

  async isAvailable(): Promise<boolean> {
    return this.cfg.enabled && isBinaryAvailable(this.cfg.binaryPath);
  }

  private async run(url: string, jobId: string): Promise<string[]> {
    if (!this.ctx) throw new Error('yt-dlp plugin not initialized');
    const stagingDir = this.ctx.allocStagingDir(jobId);
    const run = runAcquireProcess({
      binaryPath: this.cfg.binaryPath,
      args: this.buildArgs(url, stagingDir),
      stagingDir,
      onProgress: (p) => this.ctx!.emitProgress(jobId, p),
      onLabel: (label) => this.ctx!.emitLabel(jobId, label),
      spawn: this.spawn,
    });
    this.activeRuns.set(jobId, run);
    try {
      return await run.done;
    } finally {
      this.activeRuns.delete(jobId);
    }
  }

  private buildArgs(url: string, stagingDir: string): string[] {
    const outputTemplate = join(stagingDir, '%(artist)s', '%(album)s', '%(title)s.%(ext)s');
    const args = [
      url,
      // Playlists routinely contain unavailable/private/deleted videos. Without
      // this, yt-dlp aborts at the first bad item and downloads nothing after
      // it; with it, the duds are skipped and the rest still download. (yt-dlp
      // still exits non-zero either way — the runner decides success by whether
      // files landed, not the exit code.)
      '--ignore-errors',
      '--extract-audio',
      '--audio-quality',
      '0',
      // Parse "Artist - Title" from the video title; %(artist)s otherwise defaults
      // to the channel/uploader name. No-op when the title has no " - ".
      '--parse-metadata',
      'title:%(artist)s - %(title)s',
      // Strip trailing "(Official Video)", "[HD]", etc. carried into the title.
      '--replace-in-metadata',
      'title',
      '\\s*[\\(\\[](?:Official|Music|Lyric|HD|HQ|Video|Audio|Live|MV|PV|Clip|Full|Visualizer|ft\\.?|feat\\.?).*?[\\)\\]]\\s*$',
      '',
      '--embed-metadata',
      '--embed-thumbnail',
      '--output',
      outputTemplate,
      '--newline',
      '--no-warnings',
    ];
    if (this.cfg.format !== 'bestaudio') args.push('--audio-format', this.cfg.format);
    // Only pass cookies when the file actually exists — a configured-but-absent
    // path must not break downloads (yt-dlp errors on a missing cookie file).
    if (this.cfg.cookiesFile && existsSync(this.cfg.cookiesFile)) {
      args.push('--cookies', this.cfg.cookiesFile);
    }
    return [...args, ...this.cfg.extraArgs];
  }
}
