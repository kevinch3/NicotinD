import { createLogger, type Logger } from '@nicotind/core';

export interface LidarrClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class LidarrClient {
  private baseUrl: string;
  private apiKey: string;
  private log: Logger;

  constructor(options: LidarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.log = createLogger('lidarr-client');
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn({ url, status: res.status, body }, 'Lidarr request failed');
      throw new Error(`Lidarr request failed: ${res.status} ${path}`);
    }

    return res.json() as Promise<T>;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/ping`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
