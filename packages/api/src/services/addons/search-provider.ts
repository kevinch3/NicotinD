import type {
  AddonSearchResponse,
  AddonSearchResult,
  BrowseDirectory,
  ISearchProvider,
  IBrowseProvider,
  NetworkPollResult,
  ProviderType,
} from '@nicotind/core';
import { BrowseUnavailableError, createLogger } from '@nicotind/core';
import type { AddonTransport } from './transport.js';
import { inferMetadataFromPath } from '../path-inference.js';

const log = createLogger('addon-provider');

/**
 * ISearchProvider/IBrowseProvider over a remote acquisition addon: the blended
 * search lane, the raw network lane, folder browse and the enqueue route all
 * work against a registered addon with zero route changes — the same contract
 * `SlskdSearchProvider` fulfils in-process. The addon's synchronous
 * search-with-wait is adapted onto the kernel's async poll shape by buffering
 * the response under a minted searchId.
 */
export class AddonSearchProvider implements ISearchProvider, IBrowseProvider {
  readonly name: string;
  readonly type: ProviderType = 'network';

  private settled = new Map<string, AddonSearchResponse | null>();

  constructor(
    addonId: string,
    private client: AddonTransport,
  ) {
    this.name = addonId;
  }

  async search(query: string): Promise<{ results: null; searchId?: string }> {
    const searchId = crypto.randomUUID();
    this.settled.set(searchId, null);
    void this.client
      .search({ query })
      .then((res) => this.settled.set(searchId, res))
      .catch((err) => {
        log.warn({ addon: this.name, err }, 'addon search failed');
        this.settled.set(searchId, { results: [], complete: true });
      });
    return { results: null, searchId };
  }

  async pollResults(searchId: string): Promise<NetworkPollResult> {
    const res = this.settled.get(searchId);
    if (res === undefined) return { state: 'complete', responseCount: 0, results: [] };
    if (res === null) return { state: 'searching', responseCount: 0, results: [] };

    // Regroup the addon's flat song rows by peer — the poll shape the blended
    // lane ranks on (peer health included, carried by every row).
    const byUser = new Map<string, { health: AddonSearchResult; files: AddonSearchResult[] }>();
    for (const row of res.results) {
      if (row.kind !== 'song' || !row.filename) continue;
      const entry = byUser.get(row.username) ?? { health: row, files: [] };
      entry.files.push(row);
      byUser.set(row.username, entry);
    }
    return {
      state: 'complete',
      responseCount: byUser.size,
      results: [...byUser.entries()].map(([username, { health, files }]) => ({
        username,
        freeUploadSlots: health.freeUploadSlots ?? 0,
        uploadSpeed: health.uploadSpeed ?? 0,
        queueLength: health.queueLength,
        files: files.map((f) => ({
          filename: f.filename!,
          size: f.size ?? 0,
          bitRate: f.bitRateKbps,
          length: undefined,
          ...inferMetadataFromPath(f.filename!, ''),
        })),
      })),
    };
  }

  async cancelSearch(searchId: string): Promise<void> {
    this.settled.delete(searchId);
  }

  async deleteSearch(searchId: string): Promise<void> {
    this.settled.delete(searchId);
  }

  /** The raw-lane enqueue: a browse-grab job on the addon. */
  async download(
    username: string,
    files: Array<{ filename: string; size: number }>,
  ): Promise<void> {
    await this.client.createJob({ intent: 'browse-grab', username, files });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.client.getHealth();
      return health.ok && health.ready;
    } catch {
      return false;
    }
  }

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    try {
      const { directories } = await this.client.browse(username);
      return directories as BrowseDirectory[];
    } catch (err) {
      log.warn({ addon: this.name, err }, 'addon browse failed');
      throw new BrowseUnavailableError();
    }
  }
}
