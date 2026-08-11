import type {
  BrowseDirectory,
  ISearchProvider,
  IBrowseProvider,
  NetworkPollResult,
  ProviderType,
} from '@nicotind/core';
import { BrowseUnavailableError } from '@nicotind/core';
import { inferMetadataFromPath } from '../services/path-inference.js';

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.wma',
  '.ape',
  '.wv',
]);

interface SlskdLike {
  searches?: {
    create(q: string): Promise<{ id: string }>;
    get(id: string): Promise<{ state: string; responseCount: number }>;
    getResponses(id: string): Promise<
      Array<{
        username: string;
        freeUploadSlots?: number;
        uploadSpeed?: number;
        queueLength?: number;
        files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
      }>
    >;
    cancel?(id: string): Promise<void>;
    delete?(id: string): Promise<void>;
  };
  transfers?: {
    enqueue(username: string, files: Array<{ filename: string; size: number }>): Promise<void>;
  };
  users?: { browseUser(username: string): Promise<BrowseDirectory[]> };
}

/**
 * Test double for the network search lane (the shape the in-process
 * `SlskdSearchProvider` fulfilled before it moved out with the addon
 * extraction, #490). Route tests exercising the provider-based search/
 * enqueue/browse paths register this against their slskd mock. Not shipped:
 * lives under test-helpers and is only imported by *.test.ts files.
 */
export class TestNetworkProvider implements ISearchProvider, IBrowseProvider {
  readonly name = 'slskd';
  readonly type: ProviderType = 'network';
  private active = new Map<string, string>();

  constructor(private ref: { current: SlskdLike | null }) {}

  async search(query: string): Promise<{ results: null; searchId?: string }> {
    const slskd = this.ref.current;
    if (!slskd?.searches) return { results: null };
    const searchId = crypto.randomUUID();
    const created = await slskd.searches.create(query);
    this.active.set(searchId, created.id);
    return { results: null, searchId };
  }

  async pollResults(searchId: string): Promise<NetworkPollResult> {
    const inner = this.active.get(searchId);
    const slskd = this.ref.current;
    if (!inner || !slskd?.searches) return { state: 'complete', responseCount: 0, results: [] };
    const search = await slskd.searches.get(inner);
    const responses = await slskd.searches.getResponses(inner);
    return {
      state: search.state === 'InProgress' ? 'searching' : 'complete',
      responseCount: search.responseCount,
      results: responses.map((r) => ({
        username: r.username,
        freeUploadSlots: r.freeUploadSlots ?? 0,
        uploadSpeed: r.uploadSpeed ?? 0,
        queueLength: r.queueLength,
        files: r.files
          .filter((f) =>
            AUDIO_EXTENSIONS.has(f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase()),
          )
          .map((f) => ({
            filename: f.filename,
            size: f.size,
            bitRate: f.bitRate,
            length: f.length,
            ...inferMetadataFromPath(f.filename, ''),
          })),
      })),
    };
  }

  async cancelSearch(searchId: string): Promise<void> {
    const inner = this.active.get(searchId);
    if (inner) await this.ref.current?.searches?.cancel?.(inner);
  }

  async deleteSearch(searchId: string): Promise<void> {
    const inner = this.active.get(searchId);
    if (inner) await this.ref.current?.searches?.delete?.(inner);
    this.active.delete(searchId);
  }

  async download(
    username: string,
    files: Array<{ filename: string; size: number }>,
  ): Promise<void> {
    const slskd = this.ref.current;
    if (!slskd?.transfers) throw new Error('network source unavailable');
    await slskd.transfers.enqueue(username, files);
  }

  async isAvailable(): Promise<boolean> {
    return this.ref.current !== null;
  }

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    const slskd = this.ref.current;
    if (!slskd?.users) throw new BrowseUnavailableError();
    return slskd.users.browseUser(username);
  }
}
