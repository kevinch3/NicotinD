import type { SlskdUserTransferGroup } from '../types.js';
import type { SlskdClient } from '../client.js';

export class TransfersApi {
  constructor(private client: SlskdClient) {}

  async getDownloads(): Promise<SlskdUserTransferGroup[]> {
    return this.client.request<SlskdUserTransferGroup[]>('/transfers/downloads');
  }

  async getUploads(): Promise<SlskdUserTransferGroup[]> {
    return this.client.request<SlskdUserTransferGroup[]>('/transfers/uploads');
  }

  async enqueue(username: string, files: Array<{ filename: string; size: number }>): Promise<void> {
    await this.client.request(`/transfers/downloads/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: JSON.stringify(files),
    });
  }

  /**
   * Cancel a download. With `remove`, slskd also drops it from its transfer
   * list — without it the row lives on forever and only a local hide keeps it
   * off screen. slskd's `Remove` filters on `TransferStateCategories.Completed`
   * and silently no-ops otherwise, so a still-in-flight transfer may survive
   * the removal (its cancellation lands asynchronously); callers must treat
   * removal as best-effort and keep a local fallback.
   */
  async cancel(username: string, id: string, opts?: { remove?: boolean }): Promise<void> {
    const query = opts?.remove ? '?remove=true' : '';
    await this.client.request(
      `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}${query}`,
      { method: 'DELETE' },
    );
  }

  /**
   * Drop every completed download (succeeded, errored or cancelled) from
   * slskd's list in one call — the bulk equivalent of cancelling each with
   * `remove=true`, without the per-transfer round trips.
   */
  async removeCompleted(): Promise<void> {
    await this.client.request('/transfers/downloads/all/completed', { method: 'DELETE' });
  }

  async cancelAll(): Promise<void> {
    const downloads = await this.getDownloads();

    const cancels: Promise<void>[] = [];
    for (const group of downloads) {
      for (const dir of group.directories) {
        for (const file of dir.files) {
          cancels.push(this.cancel(group.username, file.id).catch(() => {}));
        }
      }
    }

    await Promise.all(cancels);
  }
}
