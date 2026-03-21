import type { ISearchProvider, IBrowseProvider, ProviderType, NetworkPollResult, BrowseDirectory } from '@nicotind/core';
import { BrowseUnavailableError } from '@nicotind/core';
import type { SlskdRef } from '../../index.js';
import { inferMetadataFromPath } from '../metadata-fixer.js';

export class SlskdSearchProvider implements ISearchProvider, IBrowseProvider {
  readonly name = 'slskd';
  readonly type: ProviderType = 'network';

  // Maps NicotinD searchId → slskd internal search id
  private activeSearches = new Map<string, string>();

  constructor(private slskdRef: SlskdRef) {}

  async search(query: string): Promise<{ results: null; searchId?: string }> {
    const slskd = this.slskdRef.current;
    if (!slskd) return { results: null };

    const searchId = crypto.randomUUID();

    try {
      const slskdSearch = await slskd.searches.create(query);
      this.activeSearches.set(searchId, slskdSearch.id);
      return { results: null, searchId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // 409 = duplicate search exists — clear old searches and retry
      if (msg.includes('409')) {
        const existing = await slskd.searches.list();
        for (const s of existing) {
          await slskd.searches.delete(s.id);
        }
        const retrySearch = await slskd.searches.create(query);
        this.activeSearches.set(searchId, retrySearch.id);
        return { results: null, searchId };
      }

      throw err;
    }
  }

  async pollResults(searchId: string): Promise<NetworkPollResult> {
    const slskdSearchId = this.activeSearches.get(searchId);
    const slskd = this.slskdRef.current;

    if (!slskdSearchId || !slskd) {
      return { state: 'complete', responseCount: 0, results: [] };
    }

    try {
      const search = await slskd.searches.get(slskdSearchId);
      const responses = await slskd.searches.getResponses(slskdSearchId);

      return {
        state: search.state === 'InProgress' ? 'searching' : 'complete',
        responseCount: search.responseCount,
        results: responses.map((r) => ({
          username: r.username,
          freeUploadSlots: r.freeUploadSlots ?? 0,
          uploadSpeed: r.uploadSpeed,
          files: (r.files ?? [])
            .filter((f) => {
              const ext = f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase();
              return ext === '.mp3' || ext === '.ogg';
            })
            .map((f) => ({
              filename: f.filename,
            size: f.size,
            bitRate: f.bitRate,
            length: f.length,
            ...inferMetadataFromPath(f.filename, ''),
          })),
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Polling failed for search ${searchId}: ${msg}`);
    }
  }

  async cancelSearch(searchId: string): Promise<void> {
    const slskdSearchId = this.activeSearches.get(searchId);
    if (!slskdSearchId) return;

    const slskd = this.slskdRef.current;
    if (slskd) await slskd.searches.cancel(slskdSearchId);
  }

  async deleteSearch(searchId: string): Promise<void> {
    const slskdSearchId = this.activeSearches.get(searchId);
    if (!slskdSearchId) return;

    const slskd = this.slskdRef.current;
    if (slskd) await slskd.searches.delete(slskdSearchId);
    this.activeSearches.delete(searchId);
  }

  async download(
    username: string,
    files: Array<{ filename: string; size: number }>,
  ): Promise<void> {
    const slskd = this.slskdRef.current;
    if (!slskd) throw new Error('Soulseek is not configured');
    await slskd.transfers.enqueue(username, files);
  }

  async isAvailable(): Promise<boolean> {
    return this.slskdRef.current !== null;
  }

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    if (!this.slskdRef.current) throw new BrowseUnavailableError();
    const dirs = await this.slskdRef.current.users.browseUser(username);
    return dirs.map((dir) => {
      const filteredFiles = dir.files.filter((f) => {
        const ext = f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase();
        return ext === '.mp3' || ext === '.ogg';
      });
      return {
        ...dir,
        files: filteredFiles,
        fileCount: filteredFiles.length,
      };
    });
  }
}
