import type { SlskdShareDirectory } from '@nicotind/core';
import type { SlskdClient } from '../client.js';
import type { OptionsApi } from './options.js';

export class SharesApi {
  constructor(
    private readonly client: SlskdClient,
    private readonly options: OptionsApi,
  ) {}

  async list(): Promise<SlskdShareDirectory[]> {
    const raw = await this.client.request<any>('/shares');
    if (Array.isArray(raw)) {
      return raw.map((s: any) => ({ path: s.id ?? s.path, fileCount: s.fileCount }));
    }
    return [];
  }

  async add(path: string): Promise<void> {
    try {
      await this.client.request('/shares', {
        method: 'POST',
        body: JSON.stringify({ id: path }),
      });
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 405) {
        await this.addViaYaml(path);
      } else {
        throw err;
      }
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.client.request(`/shares/${encodeURIComponent(path)}`, { method: 'DELETE' });
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 405) {
        await this.removeViaYaml(path);
      } else {
        throw err;
      }
    }
  }

  async rescan(): Promise<void> {
    await this.client.request('/shares', { method: 'PUT' });
  }

  private async addViaYaml(path: string): Promise<void> {
    const yaml = await this.options.getYaml();
    if (yaml.includes(path)) return;
    const updated = yaml.includes('shares:')
      ? yaml.replace(/^(shares:\s*\n(?:\s+.*\n)*\s+directories:\s*\n)/m, `$1    - ${path}\n`)
      : yaml + `\nshares:\n  directories:\n    - ${path}\n`;
    await this.options.updateYaml(updated);
  }

  private async removeViaYaml(path: string): Promise<void> {
    const yaml = await this.options.getYaml();
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const updated = yaml.replace(new RegExp(`^[ \\t]*-[ \\t]*${escaped}\\r?\\n`, 'm'), '');
    await this.options.updateYaml(updated);
  }
}
