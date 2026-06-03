/**
 * Display-only mirror of the server's hunt query builder so the hunt modal can
 * show the user exactly which Soulseek search strings a hunt fires.
 *
 * Canonical source: `buildSkewedQueries` / `stripTitleQualifiers` in
 * packages/api/src/services/album-hunter.service.ts. Kept in sync by the
 * matching unit tests on both sides — this copy exists only because the web
 * bundle can't import the server module (it pulls in pino/node deps). If the
 * server logic changes, update this too.
 */

/** The two unmodified queries every hunt always runs first. */
export function baseQueries(artist: string, album: string): string[] {
  return [`${artist} ${album}`, `${artist} - ${album}`];
}

/** Strip "(feat …)"/"(Remix)"/bracketed qualifiers — matches the server helper. */
export function stripTitleQualifiers(title: string): string {
  return title
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring|with)\b.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The textually-skewed variants a hunt also tries (soft-ban bypass) when the
 * base queries don't confidently find a complete folder. De-duped against the
 * base queries and each other, mirroring the server.
 */
export function skewedQueries(artist: string, album: string): string[] {
  const stripThe = (s: string) => s.replace(/^the\s+/i, '').trim();
  const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? '';
  const core = stripTitleQualifiers(album);

  // Artist-name truncation: drop the trailing character so Soulseek's phrase
  // matcher sees a partial token rather than the exact banned name. Effective
  // for Spanish/Portuguese names ending in -o/-a/-e (e.g. "Bahiano" → "Bahian").
  const truncArtist = artist.slice(0, -1);

  const variants = [
    `${album} ${artist}`,
    album,
    `${stripThe(artist)} ${stripThe(album)}`,
    `${artist} ${firstWord(album)}`,
    `${artist} ${core}`,
    core,
    ...(truncArtist.length >= 3 ? [`${truncArtist} ${album}`, `${truncArtist} - ${album}`] : []),
  ];

  const seen = new Set(baseQueries(artist, album).map((q) => q.toLowerCase().trim()));
  const out: string[] = [];
  for (const raw of variants) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
