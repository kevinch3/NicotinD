import type { NavidromeClient } from '../client.js';

export class MediaApi {
  constructor(private client: NavidromeClient) {}

  async stream(id: string, options: { maxBitRate?: number; format?: string } = {}): Promise<Response> {
    const params: Record<string, string> = { id };
    if (options.maxBitRate) params.maxBitRate = String(options.maxBitRate);
    if (options.format) params.format = options.format;
    return this.client.requestRaw('stream.view', params);
  }

  async getCoverArt(id: string, size?: number): Promise<Response> {
    const params: Record<string, string> = { id };
    if (size) params.size = String(size);
    return this.client.requestRaw('getCoverArt.view', params);
  }

  async download(id: string): Promise<Response> {
    return this.client.requestRaw('download.view', { id });
  }
}
