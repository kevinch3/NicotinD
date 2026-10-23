import type { Album, Artist, ArtistCredit, Song } from '@nicotind/core';

/**
 * NicotinD library DTOs → OpenSubsonic shapes (docs/opensubsonic.md).
 *
 * The inputs are what `/api/library/*` already returns, so this file only renames
 * and reshapes. NicotinD's types descend from Navidrome's, so durations are
 * seconds and bit rates kbps already — the units Subsonic expects.
 *
 * `starred` is per user: song stars are the caller's likes, album and artist
 * stars live in `user_starred_items`. The library's own `starred` column is a
 * scanner-era global and is deliberately ignored here.
 */

export interface StarLookup {
  songs: Map<string, string>;
  albums: Map<string, string>;
  artists: Map<string, string>;
}

const EPOCH = new Date(0).toISOString();

export const NO_STARS: StarLookup = { songs: new Map(), albums: new Map(), artists: new Map() };

export type LibraryAlbum = Album & { classification?: string };

const RELEASE_TYPE: Record<string, string> = {
  album: 'Album',
  ep: 'EP',
  single: 'Single',
  compilation: 'Compilation',
};

/** ISO-8601, or undefined for a value that does not parse (Subsonic clients reject garbage). */
export function isoDate(v: string | undefined | null): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function artistRefs(
  credits: ArtistCredit[] | undefined,
  fallback: { id: string; name: string },
): Array<{ id: string; name: string }> {
  if (credits && credits.length > 0) return credits.map((a) => ({ id: a.id, name: a.name }));
  return [{ id: fallback.id, name: fallback.name }];
}

export function toArtistID3(a: Artist, stars: StarLookup = NO_STARS) {
  return {
    id: a.id,
    name: a.name,
    albumCount: a.albumCount,
    coverArt: a.coverArt ?? a.id,
    starred: stars.artists.get(a.id),
  };
}

export function toAlbumID3(a: LibraryAlbum, stars: StarLookup = NO_STARS) {
  const type = a.classification ? RELEASE_TYPE[a.classification] : undefined;
  return {
    id: a.id,
    name: a.name,
    // `title`/`album` are the AlbumList (folder-era) spellings; harmless on ID3.
    title: a.name,
    album: a.name,
    isDir: true,
    artist: a.artist,
    artistId: a.artistId,
    coverArt: a.coverArt ?? a.id,
    songCount: a.songCount,
    duration: a.duration,
    // Required on AlbumID3: a client that validates the schema (py-opensonic,
    // so Music Assistant) drops the whole response over one missing value.
    created: isoDate(a.created) ?? EPOCH,
    year: a.year,
    genre: a.genre,
    starred: stars.albums.get(a.id),
    genres: a.genre ? [{ name: a.genre }] : [],
    artists: artistRefs(a.artists, { id: a.artistId, name: a.artist }),
    displayArtist: a.artist,
    releaseTypes: type ? [type] : [],
    isCompilation: a.classification === 'compilation',
  };
}

export function toChild(s: Song, stars: StarLookup = NO_STARS) {
  const genres = s.genres && s.genres.length > 0 ? s.genres : s.genre ? [s.genre] : [];
  return {
    id: s.id,
    parent: s.albumId,
    isDir: false,
    title: s.title,
    album: s.album,
    artist: s.artist,
    track: s.track,
    discNumber: s.disc,
    year: s.year,
    genre: s.genre,
    coverArt: s.albumId,
    size: s.size,
    contentType: s.contentType || undefined,
    suffix: s.suffix || undefined,
    duration: s.duration,
    bitRate: s.bitRate || undefined,
    // Relative path, never the host's absolute one.
    path: s.path,
    created: isoDate(s.created),
    albumId: s.albumId,
    artistId: s.artistId,
    type: 'music',
    mediaType: 'song',
    starred: stars.songs.get(s.id),
    bpm: s.bpm,
    samplingRate: s.sampleRate,
    bitDepth: s.bitDepth,
    channelCount: s.channels,
    genres: genres.map((name) => ({ name })),
    artists: artistRefs(s.artists, { id: s.artistId, name: s.artist }),
    displayArtist: s.artist,
    albumArtists: s.albumArtistId
      ? [{ id: s.albumArtistId, name: s.albumArtist ?? '' }]
      : undefined,
    displayAlbumArtist: s.albumArtist,
    displayComposer: s.composer,
  };
}

/** Subsonic's default ignored articles, stripped when sorting an index. */
export const IGNORED_ARTICLES = ['The', 'El', 'La', 'Los', 'Las', 'Le', 'Les'];

function sortName(name: string): string {
  for (const article of IGNORED_ARTICLES) {
    const prefix = `${article} `;
    if (name.length > prefix.length && name.toLowerCase().startsWith(prefix.toLowerCase())) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

/** Group artists into Subsonic's A–Z `index` buckets; anything else lands in `#`. */
export function artistIndex<T extends { name: string }>(
  artists: T[],
): Array<{ name: string; artist: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const a of artists) {
    const first = sortName(a.name).normalize('NFD').replace(/\p{M}/gu, '').charAt(0).toUpperCase();
    const key = /[A-Z]/.test(first) ? first : '#';
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }
  return [...buckets.keys()]
    .sort((x, y) => (x === '#' ? 1 : y === '#' ? -1 : x.localeCompare(y)))
    .map((name) => ({
      name,
      artist: (buckets.get(name) ?? []).sort((x, y) =>
        sortName(x.name).localeCompare(sortName(y.name), undefined, { sensitivity: 'base' }),
      ),
    }));
}
