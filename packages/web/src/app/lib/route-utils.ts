export function resolveArtistRoute(artistId: string | undefined): string[] {
  if (!artistId) return ['/library'];
  return ['/library', 'artists', artistId];
}

/**
 * Resolve the router target for an artist link when the id may be unknown (e.g. a
 * track played from a Soulseek network result has no `artistId`). Falls back to a
 * name lookup (`lookupByName` → the artist's id when they exist locally), and to
 * `/library` when neither an id nor a local artist match is available.
 */
export async function resolveArtistTarget(
  input: { artistId?: string; artist?: string },
  lookupByName: (name: string) => Promise<string | null>,
): Promise<string[]> {
  if (input.artistId) return ['/library', 'artists', input.artistId];
  const name = input.artist?.trim();
  if (name) {
    const id = await lookupByName(name);
    if (id) return ['/library', 'artists', id];
  }
  return ['/library'];
}

export function resolveAlbumRoute(albumId: string | undefined): string[] {
  if (!albumId) return ['/library'];
  return ['/library', 'albums', albumId];
}

export function resolveGenreRoute(genreSlug: string | undefined): string[] {
  if (!genreSlug) return ['/library'];
  return ['/library', 'genres', genreSlug];
}
