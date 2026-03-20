import type { SlskdClient } from '../client.js';

export class SessionApi {
  constructor(private client: SlskdClient) {}

  async isEnabled(): Promise<boolean> {
    const res = await this.client.request<{ isEnabled: boolean }>('/session/enabled');
    return res.isEnabled;
  }
}
