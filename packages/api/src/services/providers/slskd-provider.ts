import type { ISearchProvider, IBrowseProvider, ProviderType, NetworkPollResult, BrowseDirectory } from '@nicotind/core';
import { BrowseUnavailableError, createLogger } from '@nicotind/core';
import type { SlskdRef } from '../../index.js';
import { inferMetadataFromPath } from '../path-inference.js';

const log = createLogger('slskd-provider');
const DEFAULT_RETRY_DELAYS_MS = [3000, 6000, 10000];

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.ogg', '.opus',
  '.m4a', '.aac', '.wav', '.aiff', '.wma', '.ape', '.wv',
]);

export interface SlskdSearchProviderOptions {
  /** Delays between retries on 5xx errors (ms). Length determines retry count. */
  retryDelaysMs?: number[];
}

async function withRetry<T>(
  op: string,
  delaysMs: number[],
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      const delay = delaysMs[attempt - 1];
      log.warn({ op, attempt }, `${op} attempt ${attempt} failed, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(' 5')) throw err;
      lastErr = err instanceof Error ? err : new Error(msg);
    }
  }
  throw lastErr!;
}

export class SlskdSearchProvider implements ISearchProvider, IBrowseProvider {
  readonly name = 'slskd';
  readonly type: ProviderType = 'network';

  // Maps NicotinD searchId → slskd internal search id
  private activeSearches = new Map<string, string>();
  private retryDelaysMs: number[];

  constructor(private slskdRef: SlskdRef, options: SlskdSearchProviderOptions = {}) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

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
          queueLength: r.queueLength,
          files: (r.files ?? [])
            .filter((f) => {
              const ext = f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase();
              return AUDIO_EXTENSIONS.has(ext);
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
    await withRetry(`enqueue:${username}`, this.retryDelaysMs, () =>
      slskd.transfers.enqueue(username, files),
    );
  }

  async isAvailable(): Promise<boolean> {
    return this.slskdRef.current !== null;
  }

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    if (!this.slskdRef.current) throw new BrowseUnavailableError();
    const slskd = this.slskdRef.current;
    return withRetry(`browse:${username}`, this.retryDelaysMs, async () => {
      const dirs = await slskd.users.browseUser(username);
      return dirs.map((dir) => {
        const filteredFiles = dir.files.filter((f) => {
          const ext = f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase();
          return AUDIO_EXTENSIONS.has(ext);
        });
        return { ...dir, files: filteredFiles, fileCount: filteredFiles.length };
      });
    });
  }
}
