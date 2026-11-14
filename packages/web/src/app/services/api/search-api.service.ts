import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { AcquisitionCandidate, ArchiveCandidate, SpotifyCandidate } from '@nicotind/core';
import type {
  SearchResult,
  NetworkResults,
  CatalogSearchResult,
  CatalogResolveResult,
  ProvisioningAccepted,
} from './api-types';

/** Search lanes: Soulseek network search + the catalog/archive/spotify lookups. */
@Injectable({ providedIn: 'root' })
export class SearchApiService {
  private http = inject(HttpClient);

  search(q: string) {
    return this.http.get<SearchResult>('/api/search', { params: { q } });
  }

  pollNetwork(searchId: string) {
    return this.http.get<NetworkResults>(`/api/search/${searchId}/network`);
  }

  cancelSearch(searchId: string) {
    return this.http.put<{ ok: boolean }>(`/api/search/${searchId}/cancel`, {});
  }

  deleteSearch(searchId: string) {
    return this.http.delete<{ ok: boolean }>(`/api/search/${searchId}`);
  }

  // Catalog (metadata-driven) search — Lidarr/MusicBrainz lookup.
  catalogSearch(q: string) {
    return this.http.get<CatalogSearchResult>('/api/catalog/search', { params: { q } });
  }

  // Load an artist's real discography on demand when the global lookup surfaced
  // none of their albums (§A6); 202 while the artist is being added to Lidarr.
  catalogDiscography(artistMbid: string, artistName: string) {
    return this.http.post<CatalogSearchResult | ProvisioningAccepted>('/api/catalog/discography', {
      artistMbid,
      artistName,
    });
  }

  // Resolves a searched album into a real Lidarr album id so the album-hunt flow
  // can run against its canonical tracklist; 202 while the artist is being added.
  catalogResolve(payload: {
    foreignAlbumId: string;
    artistMbid: string;
    artistName: string;
    albumTitle: string;
  }) {
    return this.http.post<CatalogResolveResult | ProvisioningAccepted>(
      '/api/catalog/resolve',
      payload,
    );
  }

  /**
   * Every enabled metadata source (archive.org, Spotify, …) in one blended list;
   * `sources` names the ones the server asked. The network lane stays on
   * `/api/search` for its live progress.
   */
  sourcesSearch(q: string) {
    return this.http.get<{ candidates: AcquisitionCandidate[]; sources: string[] }>(
      '/api/sources/search',
      { params: { q } },
    );
  }

  archiveSearchAlbum(artist: string, album: string) {
    return this.http.get<{ candidates: ArchiveCandidate[] }>('/api/archive/search', {
      params: { artist, album },
    });
  }

  // Spotify album lookup for the album-hunt modal; download via AcquireService
  // with the candidate's `url` (spotDL resolves it).
  spotifySearchAlbum(artist: string, album: string) {
    return this.http.get<{ candidates: SpotifyCandidate[] }>('/api/spotify/search', {
      params: { artist, album },
    });
  }
}
