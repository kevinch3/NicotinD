import type { SlskdServerState } from '@nicotind/core';
import type { SlskdClient } from '../client.js';

export class ServerApi {
  constructor(private client: SlskdClient) {}

  async connect(): Promise<void> {
    await this.client.requestText('/server', { method: 'PUT' });
  }

  async disconnect(message = 'Disconnected by NicotinD'): Promise<void> {
    await this.client.requestText('/server', {
      method: 'DELETE',
      body: JSON.stringify(message),
    });
  }

  async getState(): Promise<SlskdServerState> {
    return this.client.request<SlskdServerState>('/server');
  }
}
