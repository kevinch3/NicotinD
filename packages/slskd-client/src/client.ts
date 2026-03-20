import { createLogger, type Logger } from '@nicotind/core';

export interface SlskdClientOptions {
  baseUrl: string;
  username: string;
  password: string;
}

export class SlskdClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private token: string | null = null;
  private log: Logger;

  constructor(options: SlskdClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.username = options.username;
    this.password = options.password;
    this.log = createLogger('slskd-client');
  }

  private async authenticate(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });

    if (!res.ok) {
      throw new Error(`slskd auth failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { token: string };
    this.token = data.token;
    this.log.info('Authenticated with slskd');
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.token) {
      await this.authenticate();
    }

    const url = `${this.baseUrl}/api/v0${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...options.headers,
      },
    });

    // Re-authenticate on 401 and retry once
    if (res.status === 401) {
      this.token = null;
      await this.authenticate();
      const retryRes = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...options.headers,
        },
      });

      if (!retryRes.ok) {
        throw new Error(`slskd request failed: ${retryRes.status} ${path}`);
      }
      return retryRes.json() as Promise<T>;
    }

    if (!res.ok) {
      throw new Error(`slskd request failed: ${res.status} ${path}`);
    }

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }
}
