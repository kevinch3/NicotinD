import type { BrowseDirectory } from '@nicotind/core';
import type { SlskdClient } from '../client.js';

export class UsersApi {
  constructor(private readonly client: SlskdClient) {}

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    const raw = await this.client.request<any[]>(
      `/users/${encodeURIComponent(username)}/browse`,
    );
    return raw.map((dir: any) => ({
      name: dir.name,
      fileCount: dir.fileCount,
      files: (dir.files ?? []).map((f: any) => ({
        filename: f.filename,
        size: f.size,
        bitRate: f.bitRate,
        length: f.length,
      })),
    }));
  }
}
