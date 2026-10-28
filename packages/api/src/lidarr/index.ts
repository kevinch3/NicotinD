import { LidarrClient, type LidarrClientOptions } from './client.js';
import type { LidarrCircuit } from './circuit.js';
import { ArtistApi } from './api/artist.js';
import { AlbumApi } from './api/album.js';
import { TrackApi } from './api/track.js';

export class Lidarr {
  private client: LidarrClient;
  private backgroundView: Lidarr | null = null;

  public artist: ArtistApi;
  public album: AlbumApi;
  public track: TrackApi;

  constructor(options: LidarrClientOptions | LidarrClient) {
    this.client = options instanceof LidarrClient ? options : new LidarrClient(options);
    this.artist = new ArtistApi(this.client);
    this.album = new AlbumApi(this.client);
    this.track = new TrackApi(this.client);
  }

  ping(): Promise<boolean> {
    return this.client.ping();
  }

  /** Lidarr's breaker, shared by this instance and its background view (#1581). */
  get circuit(): LidarrCircuit {
    return this.client.circuit;
  }

  /** The same Lidarr for enrichment and pollers: fails fast while the breaker is open. */
  background(): Lidarr {
    const client = this.client.background();
    if (client === this.client) return this;
    this.backgroundView ??= new Lidarr(client);
    return this.backgroundView;
  }

  /**
   * One cheap call whose outcome decides whether a paused breaker closes. On the
   * background view it is the probe the breaker lets through after a cool-down.
   */
  async probe(): Promise<boolean> {
    try {
      await this.client.request('/api/v1/system/status');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The breaker behind a Lidarr handle, or null. Read through here rather than
 * `lidarr.circuit` because enrichment contexts and tests pass partial stubs.
 */
export function lidarrCircuit(lidarr: Lidarr | null | undefined): LidarrCircuit | null {
  return (lidarr as { circuit?: LidarrCircuit } | null | undefined)?.circuit ?? null;
}

export { LidarrClient, LidarrTimeoutError, LidarrUnavailableError } from './client.js';
export { LidarrCircuit } from './circuit.js';
export type { LidarrClientOptions } from './client.js';
export type {
  LidarrArtist,
  LidarrAlbum,
  LidarrAlbumRelease,
  LidarrTrack,
  LidarrImage,
  LidarrQualityProfile,
  LidarrMetadataProfile,
  LidarrRootFolder,
} from './types.js';
