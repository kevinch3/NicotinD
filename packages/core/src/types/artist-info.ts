/** Response shape shared by the artist-info attach/refresh/edit routes (issue #195). */
export interface ArtistInfoResponse {
  bio: string | null;
  urls: string[];
}
