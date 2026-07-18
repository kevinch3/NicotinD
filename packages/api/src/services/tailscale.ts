import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { getRemoteAccessSettings, setRemoteAccessSettings } from './remote-access-settings.js';

const log = createLogger('remote-access');

/**
 * Remote access via Tailscale Funnel: the backend stays loopback-bound and
 * `tailscale funnel --bg <port>` publishes it at a stable public
 * https://<machine>.<tailnet>.ts.net URL. Only this machine needs Tailscale —
 * the phone reaches a plain public HTTPS URL. The guided UI walks the user
 * through install → login → funnel approval via the typed state below.
 */
export type RemoteAccessState =
  | { kind: 'not-installed' }
  | { kind: 'needs-login'; authUrl?: string }
  | { kind: 'needs-operator'; command: string }
  | { kind: 'funnel-not-enabled'; enableUrl?: string }
  | { kind: 'inactive'; publicUrl?: string }
  | { kind: 'active'; publicUrl: string }
  | { kind: 'error'; detail: string };

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** null when the binary could not be spawned at all (ENOENT). */
  code: number | null;
}

export type TailscaleRunner = (args: string[], timeoutMs: number) => Promise<ExecResult>;

/** GUI-launched apps (Electron) inherit a minimal PATH — same problem
 * `acquireEnv` solves for yt-dlp/spotdl. Probe the usual extra locations plus
 * the macOS app-bundle CLI. */
const TAILSCALE_CANDIDATES = [
  'tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  '/usr/sbin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

function pathAugmentedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const existing = (base.PATH ?? '').split(':').filter(Boolean);
  const prepend = ['/opt/homebrew/bin', '/usr/local/bin'];
  if (base.HOME) prepend.push(join(base.HOME, '.local/bin'));
  const missing = prepend.filter((dir) => !existing.includes(dir));
  return { ...base, PATH: [...missing, ...existing].join(':') };
}

function execTailscale(binary: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, env: pathAugmentedEnv(), encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error && 'code' in error && typeof error.code === 'string'
            ? null // spawn failure (ENOENT etc.) — binary missing
            : error
              ? ((error as { code?: number }).code ?? 1)
              : 0;
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
  });
}

let cachedBinary: string | null | undefined;

export async function findTailscaleBinary(): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary;
  for (const candidate of TAILSCALE_CANDIDATES) {
    const result = await execTailscale(candidate, ['version'], 3000);
    if (result.code === 0) {
      cachedBinary = candidate;
      return candidate;
    }
  }
  cachedBinary = null;
  return null;
}

/** Test hook: reset the memoized binary lookup. */
export function resetTailscaleBinaryCache(): void {
  cachedBinary = undefined;
}

export interface TailscaleStatus {
  loggedIn: boolean;
  /** MagicDNS name without the trailing dot, e.g. "desk.tail1234.ts.net". */
  magicDnsName: string | null;
  authUrl: string | null;
}

/** Pure parser over `tailscale status --json` output; tolerant of missing fields. */
export function parseTailscaleStatus(json: string): TailscaleStatus | null {
  try {
    const parsed = JSON.parse(json) as {
      BackendState?: string;
      AuthURL?: string;
      Self?: { DNSName?: string };
    };
    const dns = parsed.Self?.DNSName?.replace(/\.$/, '') || null;
    return {
      loggedIn: parsed.BackendState === 'Running',
      magicDnsName: dns,
      authUrl: parsed.AuthURL || null,
    };
  } catch {
    return null;
  }
}

/** Pure parser for `tailscale funnel` failure output: Tailscale prints an
 * admin-console URL when the funnel node attribute isn't enabled yet. */
export function parseFunnelEnableUrl(output: string): string | null {
  const match = output.match(/https:\/\/login\.tailscale\.com\/\S*funnel\S*/i);
  return match ? match[0].replace(/[.,)]+$/, '') : null;
}

/** Pure parser for tailscaled's Linux operator restriction: serve/funnel config
 * changes are root-only until `sudo tailscale set --operator=<user>` is run
 * once. The CLI error carries the `--operator=` hint — detect it so the UI can
 * guide that one-time command instead of dumping the raw sudo error. */
export function parseOperatorDenied(output: string): boolean {
  return /access denied/i.test(output) && /--operator=/.test(output);
}

export class RemoteAccess {
  private port: number | null = null;
  private lastError: string | null = null;
  private armed = false;

  constructor(
    private readonly db: Database,
    private readonly run: TailscaleRunner | null = null,
  ) {}

  get enabled(): boolean {
    return getRemoteAccessSettings(this.db).enabled;
  }

  private async exec(args: string[], timeoutMs: number): Promise<ExecResult | null> {
    if (this.run) return this.run(args, timeoutMs);
    const binary = await findTailscaleBinary();
    if (!binary) return null;
    return execTailscale(binary, args, timeoutMs);
  }

  /** Called once the HTTP server is listening (the port is only known then). */
  async onServerStarted(port: number): Promise<void> {
    this.port = port;
    if (!this.enabled) return;
    const state = await this.arm();
    if (state.kind !== 'active') {
      log.warn({ state }, 'Remote access enabled but funnel is not active');
    }
  }

  async status(): Promise<{ enabled: boolean; state: RemoteAccessState }> {
    const enabled = this.enabled;
    return { enabled, state: await this.currentState() };
  }

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; state: RemoteAccessState }> {
    setRemoteAccessSettings(this.db, { enabled });
    if (enabled) {
      const state = await this.arm();
      return { enabled, state };
    }
    await this.disarm();
    return { enabled, state: await this.currentState() };
  }

  /** The public URL when funnel is active, else null. */
  async publicUrl(): Promise<string | null> {
    if (!this.enabled || !this.armed) return null;
    const status = await this.tailscaleStatus();
    return status?.loggedIn && status.magicDnsName ? `https://${status.magicDnsName}` : null;
  }

  private async tailscaleStatus(): Promise<TailscaleStatus | null> {
    const result = await this.exec(['status', '--json'], 4000);
    if (!result || result.code === null) return null;
    return parseTailscaleStatus(result.stdout);
  }

  private async currentState(): Promise<RemoteAccessState> {
    const result = await this.exec(['status', '--json'], 4000);
    if (!result || result.code === null) return { kind: 'not-installed' };
    const status = parseTailscaleStatus(result.stdout);
    if (!status) return { kind: 'error', detail: 'Could not read tailscale status' };
    if (!status.loggedIn) return { kind: 'needs-login', authUrl: status.authUrl ?? undefined };
    const publicUrl = status.magicDnsName ? `https://${status.magicDnsName}` : undefined;
    if (this.lastError) {
      if (parseOperatorDenied(this.lastError)) {
        // The username the backend runs as is exactly who must become the
        // tailscaled operator — it's the user invoking the CLI.
        return {
          kind: 'needs-operator',
          command: `sudo tailscale set --operator=${userInfo().username}`,
        };
      }
      const enableUrl = parseFunnelEnableUrl(this.lastError);
      if (enableUrl) return { kind: 'funnel-not-enabled', enableUrl };
      return { kind: 'error', detail: this.lastError };
    }
    if (this.armed && publicUrl) return { kind: 'active', publicUrl };
    return { kind: 'inactive', publicUrl };
  }

  private async arm(): Promise<RemoteAccessState> {
    if (this.port === null) return { kind: 'error', detail: 'Server port not known yet' };
    const result = await this.exec(['funnel', '--bg', String(this.port)], 10_000);
    if (!result || result.code === null) return { kind: 'not-installed' };
    if (result.code !== 0) {
      this.armed = false;
      this.lastError = (result.stderr || result.stdout).trim() || 'tailscale funnel failed';
      log.warn({ detail: this.lastError }, 'Failed to arm tailscale funnel');
      return this.currentState();
    }
    this.armed = true;
    this.lastError = null;
    return this.currentState();
  }

  private async disarm(): Promise<void> {
    this.armed = false;
    this.lastError = null;
    // `funnel reset` clears the background funnel config; tolerate CLI drift —
    // a failed reset just leaves an inert proxy to a loopback port.
    const result = await this.exec(['funnel', 'reset'], 10_000);
    if (result && result.code !== 0) {
      log.warn({ stderr: result.stderr.trim() }, 'tailscale funnel reset failed');
    }
  }
}
