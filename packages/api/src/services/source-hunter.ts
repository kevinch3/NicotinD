import {
  createLogger,
  mergeCandidates,
  archiveToCandidate,
  spotifyToCandidate,
  type AcquisitionCandidate,
} from '@nicotind/core';
import type { ArchiveSearchService } from './archive-search.service.js';
import type { SpotifySearchService } from './spotify-search.service.js';

const log = createLogger('source-hunter');

/**
 * A source that can hunt a *specific* album (artist + title) and return acquirable
 * candidates. This is the source-agnostic hunt capability: the orchestrator
 * depends on this interface, never on a concrete client, so a new source is one
 * implementation + its pure mapper (see docs/source-agnostic-acquisition.md).
 *
 * Soulseek's hunt is a separate specialized two-phase service (live peer search
 * drives the modal's progress UI); these `SourceHunter`s are the request/response
 * metadata sources (archive.org, Spotify, future) that previously lived as
 * bolted-on "Also on…" lanes.
 */
export interface SourceHunter {
  /** Plugin id used to gate the source via the registry. */
  readonly id: string;
  huntAlbum(artist: string, album: string): Promise<AcquisitionCandidate[]>;
}

export class ArchiveAlbumHunter implements SourceHunter {
  readonly id = 'archive';
  constructor(private readonly search: ArchiveSearchService) {}
  async huntAlbum(artist: string, album: string): Promise<AcquisitionCandidate[]> {
    return (await this.search.searchAlbum(artist, album)).map(archiveToCandidate);
  }
}

export class SpotifyAlbumHunter implements SourceHunter {
  readonly id = 'spotify';
  constructor(private readonly search: SpotifySearchService) {}
  async huntAlbum(artist: string, album: string): Promise<AcquisitionCandidate[]> {
    return (await this.search.searchAlbum(artist, album)).map(spotifyToCandidate);
  }
}

/**
 * Fans an album hunt out across every *enabled* `SourceHunter`, mapping each to
 * the unified candidate shape and merging into one ranked list. Per-source
 * failures are isolated. Registry-gated, so disabling a source's plugin removes
 * its candidates with no route/UI change.
 */
export class AlbumHuntOrchestrator {
  constructor(
    private readonly hunters: SourceHunter[],
    private readonly isEnabled: (id: string) => boolean,
  ) {}

  enabledSourceIds(): string[] {
    return this.hunters.filter((h) => this.isEnabled(h.id)).map((h) => h.id);
  }

  async hunt(artist: string, album: string): Promise<AcquisitionCandidate[]> {
    const active = this.hunters.filter((h) => this.isEnabled(h.id));
    if (active.length === 0) return [];
    const lists = await Promise.all(
      active.map((h) =>
        h.huntAlbum(artist, album).catch((err) => {
          log.warn(
            { source: h.id, artist, album, err: err instanceof Error ? err.message : String(err) },
            'source hunt failed',
          );
          return [] as AcquisitionCandidate[];
        }),
      ),
    );
    return mergeCandidates(...lists);
  }
}
