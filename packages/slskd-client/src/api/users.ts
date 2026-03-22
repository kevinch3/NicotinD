import type { BrowseDirectory } from '@nicotind/core';
import type { SlskdClient } from '../client.js';

export class UsersApi {
  constructor(private readonly client: SlskdClient) {}

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    const raw = await this.client.request<any>(
      `/users/${encodeURIComponent(username)}/browse`,
    );

    let rawDirs: any[] = [];
    if (Array.isArray(raw)) {
      rawDirs = raw;
    } else if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.directories)) {
        rawDirs = raw.directories;
      } else if (raw.name || (raw.files && Array.isArray(raw.files))) {
        // It's a single directory object
        rawDirs = [raw];
      }
    }

    if (rawDirs.length === 0 && !Array.isArray(raw)) {
       // If we still found nothing and it wasn't an (empty) array, then it's an unexpected format
       throw new Error(`Unexpected browse response: expected array or directory object, got ${typeof raw}`);
    }

    return rawDirs.map((dir: any) => ({
      name: dir.name,
      fileCount: dir.fileCount,
      files: (dir.files ?? []).map((f: any) => {
        // slskd browse returns bare filenames (e.g. "01 - Track.mp3") but downloads
        // require the full Soulseek path (e.g. "@@share\\Artist\\Album\\01 - Track.mp3").
        // Prepend the directory name when the filename is a bare name.
        const fname: string = f.filename;
        const hasPath = fname.includes('\\') || fname.includes('/');
        return {
          filename: hasPath ? fname : `${dir.name}\\${fname}`,
          size: f.size,
          bitRate: f.bitRate,
          length: f.length,
        };
      }),
    }));
  }
}
