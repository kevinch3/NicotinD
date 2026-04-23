export function resolveArtistRoute(artistId: string | undefined): string[] {
  if (!artistId) return ['/library'];
  return ['/library', 'artists', artistId];
}

export function resolveAlbumRoute(albumId: string | undefined): string[] {
  if (!albumId) return ['/library'];
  return ['/library', 'albums', albumId];
}

export function resolveGenreRoute(genreSlug: string | undefined): string[] {
  if (!genreSlug) return ['/library'];
  return ['/library', 'genres', genreSlug];
}
