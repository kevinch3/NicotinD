import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { ArchiveCandidate, SpotifyCandidate } from '@nicotind/core';
import type {
  SearchResult,
  NetworkResults,
  CatalogSearchResult,
  CatalogResolveResult,
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

  // Load an artist's real discography on demand (adds the artist to Lidarr) when
  // the global lookup surfaced none of their albums. See §A6.
  catalogDiscography(artistMbid: string, artistName: string) {
    return this.http.post<CatalogSearchResult>('/api/catalog/discography', {
      artistMbid,
      artistName,
    });
  }

  // Resolves a searched album into a real Lidarr album id (adding the artist on
  // demand) so the album-hunt flow can run against its canonical tracklist.
  catalogResolve(payload: {
    foreignAlbumId: string;
    artistMbid: string;
    artistName: string;
    albumTitle: string;
  }) {
    return this.http.post<CatalogResolveResult>('/api/catalog/resolve', payload);
  }

  // archive.org search lane — returns item candidates; download via AcquireService
  // with the candidate's detailsUrl. 503s when the archive plugin is disabled.
  archiveSearch(q: string) {
    return this.http.get<{ candidates: ArchiveCandidate[] }>('/api/archive/search', {
      params: { q },
    });
  }

  archiveSearchAlbum(artist: string, album: string) {
    return this.http.get<{ candidates: ArchiveCandidate[] }>('/api/archive/search', {
      params: { artist, album },
    });
  }

  // Spotify metadata fallback lane — returns album candidates; download via
  // AcquireService with the candidate's `url` (spotDL resolves it). 503s when the
  // spotify plugin is disabled or its credentials aren't configured.
  spotifySearch(q: string) {
    return this.http.get<{ candidates: SpotifyCandidate[] }>('/api/spotify/search', {
      params: { q },
    });
  }

  spotifySearchAlbum(artist: string, album: string) {
    return this.http.get<{ candidates: SpotifyCandidate[] }>('/api/spotify/search', {
      params: { artist, album },
    });
  }
}
