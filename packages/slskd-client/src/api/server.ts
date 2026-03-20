import type { SlskdServerState } from '@nicotind/core';
import type { SlskdClient } from '../client.js';

export class ServerApi {
  constructor(private client: SlskdClient) {}

  async getState(): Promise<SlskdServerState> {
    return this.client.request<SlskdServerState>('/server');
  }
}
