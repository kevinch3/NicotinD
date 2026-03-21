import type { SlskdClient } from '../client.js';

export class OptionsApi {
  constructor(private client: SlskdClient) {}

  async getYaml(): Promise<string> {
    return this.client.request<string>('/options/yaml');
  }

  async updateYaml(yaml: string): Promise<void> {
    await this.client.request<string>('/options/yaml', {
      method: 'PUT',
      body: JSON.stringify(yaml),
    });
  }
}
