import type { SlskdApplicationInfo } from '../types.js';
import type { SlskdClient } from '../client.js';

export class ApplicationApi {
  constructor(private readonly client: SlskdClient) {}

  async getInfo(): Promise<SlskdApplicationInfo> {
    return this.client.request<SlskdApplicationInfo>('/application');
  }
}
