import type { SlskdUserTransferGroup } from '@nicotind/core';
import type { SlskdClient } from '../client.js';

export class TransfersApi {
  constructor(private client: SlskdClient) {}

  async getDownloads(): Promise<SlskdUserTransferGroup[]> {
    return this.client.request<SlskdUserTransferGroup[]>('/transfers/downloads');
  }

  async enqueue(
    username: string,
    files: Array<{ filename: string; size: number }>,
  ): Promise<void> {
    await this.client.request(`/transfers/downloads/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: JSON.stringify(files),
    });
  }

  async cancel(username: string, id: string): Promise<void> {
    await this.client.request(
      `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  async cancelAll(): Promise<void> {
    await this.client.request('/transfers/downloads', { method: 'DELETE' });
  }
}
