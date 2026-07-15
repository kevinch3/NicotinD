import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { backendEntry, bunBinary, ffmpegBinaryPath, logsDir, userDataDir, webDistPath } from './paths.js';

/** The shape of the child process spawned below: no stdin, piped stdout/stderr. */
type SidecarChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const HANDSHAKE_RE = /^NICOTIND_LISTENING\s+(\d+)\s*$/;

/**
 * Parses the backend's stdout handshake line (`src/main.ts`: `console.log(
 * \`NICOTIND_LISTENING ${server.port}\`)`) into the bound port number.
 * Returns `null` for any other line (log noise, unrelated stdout, etc).
 * Pure — this is the primary unit-tested surface of this module.
 */
export function parseListeningPort(line: string): number | null {
  const match = HANDSHAKE_RE.exec(line.trim());
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

const HEALTH_POLL_INTERVAL_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB per generation
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const MAX_RESTART_ATTEMPTS = 8;
const KILL_GRACE_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SidecarOptions {
  /** Optional music directory to hand the backend (onboarding sets this later; omit to let the backend use its default/config). */
  musicDir?: string;
}

export interface SidecarExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  attempts: number;
}

/**
 * Supervises the Bun backend as a child process ("sidecar").
 *
 * `start()` spawns `bun run <backendEntry>` (Variant B — no compiled
 * binary), tees its stdout/stderr to a rotating log file, and resolves with
 * the sidecar's base URL once BOTH (a) the `NICOTIND_LISTENING <port>`
 * stdout handshake has been seen, AND (b) `GET /api/health` on that port
 * returns `{ ok: true }`. If the child exits or the handshake+health gate
 * times out before that, `start()` rejects.
 *
 * Once started, an unexpected exit (i.e. not initiated by `stop()`)
 * triggers a supervised restart with capped exponential backoff
 * (500ms → 10s), up to `MAX_RESTART_ATTEMPTS` attempts; a successful
 * restart emits `'restart'` with the new URL (attempts counter resets),
 * exhausting all attempts emits `'exit'` with the failure info.
 */
export class Sidecar extends EventEmitter {
  private readonly musicDir: string | undefined;
  private child: SidecarChildProcess | null = null;
  private stopping = false;
  private restartAttempts = 0;
  private logStream: WriteStream | null = null;
  private currentUrl: string | null = null;

  constructor(options: SidecarOptions = {}) {
    super();
    this.musicDir = options.musicDir;
  }

  /** Absolute path to the (active) sidecar log file. */
  logFilePath(): string {
    return path.join(logsDir(), 'sidecar.log');
  }

  /** The base URL of the currently-running sidecar, if any. */
  url(): string | null {
    return this.currentUrl;
  }

  /** Spawns the backend and resolves with its base URL once confirmed healthy. */
  async start(): Promise<string> {
    this.stopping = false;
    this.restartAttempts = 0;
    const url = await this.spawnAndWaitForHandshake();
    this.currentUrl = url;
    return url;
  }

  /**
   * Stops the sidecar. Sets a flag first so the exit handler doesn't treat
   * this as an unexpected exit and try to restart it. SIGTERM first (the
   * backend handles it gracefully — `src/main.ts`), SIGKILL if it hasn't
   * exited within `KILL_GRACE_MS`.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.closeLogStream();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.closeLogStream();
  }

  private openLogStream(): WriteStream {
    const file = this.logFilePath();
    this.rotateLogIfNeeded(file);
    const stream = createWriteStream(file, { flags: 'a' });
    this.logStream = stream;
    return stream;
  }

  private closeLogStream(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  /** Size-based rotation: keeps the active file plus up to two backup generations. */
  private rotateLogIfNeeded(file: string): void {
    if (!existsSync(file)) {
      return;
    }
    try {
      const { size } = statSync(file);
      if (size <= MAX_LOG_BYTES) {
        return;
      }
      const gen1 = `${file}.1`;
      const gen2 = `${file}.2`;
      if (existsSync(gen1)) {
        renameSync(gen1, gen2);
      }
      renameSync(file, gen1);
    } catch {
      // Rotation is best-effort; a logging hiccup must never take down the sidecar.
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NICOTIND_PORT: '0',
      NICOTIND_BIND_HOST: '127.0.0.1',
      // v1 is local-library only — don't let the backend try to download/spawn slskd+Lidarr.
      NICOTIND_MODE: 'external',
      NICOTIND_DATA_DIR: userDataDir(),
      NICOTIND_WEB_DIST: webDistPath(),
    };
    const ffmpeg = ffmpegBinaryPath();
    if (ffmpeg) {
      env.NICOTIND_FFMPEG_PATH = ffmpeg;
    }
    if (this.musicDir) {
      env.NICOTIND_MUSIC_DIR = this.musicDir;
    }
    return env;
  }

  private async waitForHealthy(port: number): Promise<string> {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean };
          if (body?.ok) {
            return url;
          }
        }
      } catch {
        // Backend isn't accepting connections yet — keep polling.
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`Sidecar health check did not pass within ${HANDSHAKE_TIMEOUT_MS}ms`);
  }

  private spawnAndWaitForHandshake(): Promise<string> {
    return new Promise((resolve, reject) => {
      const logStream = this.openLogStream();
      const child = spawn(bunBinary(), ['run', backendEntry()], {
        env: this.buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      let settled = false;
      const rl = readline.createInterface({ input: child.stdout });

      const cleanupListeners = (): void => {
        rl.removeListener('line', onLine);
        rl.close();
      };

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        child.kill('SIGTERM');
        reject(new Error(`Sidecar did not become healthy within ${HANDSHAKE_TIMEOUT_MS}ms`));
      }, HANDSHAKE_TIMEOUT_MS);

      const onLine = (line: string): void => {
        logStream.write(line + '\n');
        if (settled) return;
        const port = parseListeningPort(line);
        if (port === null) return;
        this.waitForHealthy(port).then(
          (url) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            resolve(url);
          },
          (err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            cleanupListeners();
            child.kill('SIGTERM');
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      };
      rl.on('line', onLine);

      child.stderr.on('data', (chunk: Buffer) => {
        logStream.write(chunk);
      });

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        cleanupListeners();
        reject(err);
      });

      child.once('exit', (code, signal) => {
        cleanupListeners();
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          reject(
            new Error(`Sidecar exited before becoming healthy (code=${code}, signal=${signal})`),
          );
          return;
        }
        this.handleUnexpectedExit(code, signal);
      });
    });
  }

  /** Called when an already-healthy sidecar's child process exits. Restarts with backoff unless `stop()` was called. */
  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.closeLogStream();
    this.child = null;
    this.currentUrl = null;
    if (this.stopping) {
      return;
    }
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      const info: SidecarExitInfo = { code, signal, attempts: this.restartAttempts };
      this.emit('exit', info);
      return;
    }
    const attempt = this.restartAttempts;
    this.restartAttempts += 1;
    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (this.stopping) return;
      this.spawnAndWaitForHandshake()
        .then((url) => {
          this.restartAttempts = 0;
          this.currentUrl = url;
          this.emit('restart', url);
        })
        .catch(() => {
          this.handleUnexpectedExit(null, null);
        });
    }, backoffMs);
  }
}
