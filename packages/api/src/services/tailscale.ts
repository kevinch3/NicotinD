import { existsSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import { execSync } from 'node:child_process';

const log = createLogger('tailscale');

export interface TailscaleStatus {
  available: boolean;
  connected: boolean;
  hostname?: string;
  ip?: string;
  loginUrl?: string;
}

export class TailscaleService {
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? process.env.TAILSCALE_SOCKET ?? '/var/run/tailscale/tailscaled.sock';
  }

  isAvailable(): boolean {
    return existsSync(this.socketPath);
  }

  async getStatus(): Promise<TailscaleStatus> {
    if (!this.isAvailable()) {
      return { available: false, connected: false };
    }

    try {
      const data = this.curlApi('GET', 'status');
      const status = JSON.parse(data);

      const selfNode = status.Self;
      const connected = status.BackendState === 'Running';

      return {
        available: true,
        connected,
        hostname: selfNode?.DNSName?.replace(/\.$/, ''),
        ip: selfNode?.TailscaleIPs?.[0],
      };
    } catch (err) {
      log.warn({ err }, 'Failed to get Tailscale status');
      return { available: true, connected: false };
    }
  }

  async connect(authKey: string): Promise<TailscaleStatus> {
    if (!this.isAvailable()) {
      throw new Error('Tailscale socket not available — is the Tailscale container running?');
    }

    try {
      await this.curlApi('POST', 'up', {
        AuthKey: authKey,
        Hostname: 'nicotind',
      });
      log.info('Tailscale connected');
      return await this.getStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Failed to connect Tailscale');
      throw new Error(`Failed to connect Tailscale: ${msg}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      this.curlApi('POST', 'down', {});
      log.info('Tailscale disconnected');
    } catch (err) {
      log.warn({ err }, 'Failed to disconnect Tailscale');
    }
  }

  private async curlApi(method: string, path: string, body?: Record<string, unknown>): Promise<string> {
    const url = `http://localhost/localapi/v0/${path}`;
    const args = [
      '--unix-socket',
      this.socketPath,
      '-X',
      method,
      '-H',
      'Content-Type: application/json',
    ];

    if (body) {
      args.push('-d', JSON.stringify(body));
    }

    args.push(url);

    try {
      return execSync(`curl ${args.map((a) => `'${a}'`).join(' ')}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stderr = err instanceof Error && 'stderr' in err ? (err as any).stderr : '';
      const stdout = err instanceof Error && 'stdout' in err ? (err as any).stdout : '';
      throw new Error(stdout || stderr || String(err));
    }
  }
}
