import type { SlskdClient } from '../client.js';

export class OptionsApi {
  constructor(private client: SlskdClient) {}

  async getYaml(): Promise<string> {
    return this.client.request<string>('/options/yaml');
  }

  /**
   * Resolved runtime options as JSON (slskd `/api/v0/options`). Shape varies by
   * slskd version, so callers extract fields defensively — see
   * `extractSlskdLimits`. Preferred over `getYaml` when you only need a few
   * values (no YAML parser needed).
   */
  async get(): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>('/options');
  }

  async updateYaml(yaml: string): Promise<void> {
    await this.client.request<string>('/options/yaml', {
      method: 'PUT',
      body: JSON.stringify(yaml),
    });
  }
}
