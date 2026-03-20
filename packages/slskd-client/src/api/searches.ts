import type { SlskdSearch, SlskdSearchResponse } from '@nicotind/core';
import type { SlskdClient } from '../client.js';

export class SearchesApi {
  constructor(private client: SlskdClient) {}

  async create(searchText: string): Promise<SlskdSearch> {
    return this.client.request<SlskdSearch>('/searches', {
      method: 'POST',
      body: JSON.stringify({ id: crypto.randomUUID(), searchText }),
    });
  }

  async get(id: string): Promise<SlskdSearch> {
    return this.client.request<SlskdSearch>(`/searches/${id}`);
  }

  async getResponses(id: string): Promise<SlskdSearchResponse[]> {
    return this.client.request<SlskdSearchResponse[]>(`/searches/${id}/responses`);
  }

  async list(): Promise<SlskdSearch[]> {
    return this.client.request<SlskdSearch[]>('/searches');
  }

  async cancel(id: string): Promise<void> {
    await this.client.request(`/searches/${id}`, { method: 'PUT' });
  }

  async delete(id: string): Promise<void> {
    await this.client.request(`/searches/${id}`, { method: 'DELETE' });
  }
}
