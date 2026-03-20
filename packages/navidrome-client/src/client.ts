import type { SubsonicResponse } from '@nicotind/core';
import { createLogger, type Logger } from '@nicotind/core';
import { authQueryString } from './subsonic-auth.js';

export interface NavidromeClientOptions {
  baseUrl: string;
  username: string;
  password: string;
}

export class NavidromeClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private log: Logger;

  constructor(options: NavidromeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.username = options.username;
    this.password = options.password;
    this.log = createLogger('navidrome-client');
  }

  async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const authQs = authQueryString(this.username, this.password);
    const extraQs = new URLSearchParams(params).toString();
    const separator = extraQs ? `&${extraQs}` : '';
    const url = `${this.baseUrl}/rest/${endpoint}?${authQs}${separator}`;

    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Navidrome request failed: ${res.status} ${endpoint}`);
    }

    const data = (await res.json()) as SubsonicResponse<T>;
    const response = data['subsonic-response'];

    if (response.status === 'failed' && response.error) {
      throw new Error(`Subsonic error ${response.error.code}: ${response.error.message}`);
    }

    return response as unknown as T;
  }

  /**
   * Returns raw Response for binary endpoints (stream, cover art)
   */
  async requestRaw(endpoint: string, params: Record<string, string> = {}): Promise<Response> {
    const authQs = authQueryString(this.username, this.password);
    const extraQs = new URLSearchParams(params).toString();
    const separator = extraQs ? `&${extraQs}` : '';
    const url = `${this.baseUrl}/rest/${endpoint}?${authQs}${separator}`;

    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Navidrome request failed: ${res.status} ${endpoint}`);
    }

    return res;
  }
}
