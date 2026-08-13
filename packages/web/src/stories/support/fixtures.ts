/**
 * One coherent fake library, reused by every story.
 *
 * The catalog reads as a product rather than 36 unrelated placeholder strings only if
 * the same artist, album and tracks recur across components. Everything here satisfies
 * the real interface — never `as any` — so a story stops compiling when a type changes,
 * which is the point of having stories in `typecheck`.
 */
import type { Track } from '../../app/services/player.service';
import type { ArtistCredit, Song } from '../../app/services/api/api-types';
import type { DownloadItem } from '../../app/lib/download-groups';
import type { GenreSlice } from '../../app/components/genre-radar/genre-radar.component';

export const DEMO_ARTIST_ID = 'artist-nocturnal-signal';
export const DEMO_ALBUM_ID = 'album-static-bloom';

export const demoArtistCredits: ArtistCredit[] = [
  { id: DEMO_ARTIST_ID, name: 'Nocturnal Signal', role: 'primary' },
  { id: 'artist-mira-oduya', name: 'Mira Oduya', role: 'featuring' },
];

export const demoTrack: Track = {
  id: 'song-opening-static',
  title: 'Opening Static',
  artist: 'Nocturnal Signal',
  artistId: DEMO_ARTIST_ID,
  artists: demoArtistCredits,
  album: 'Static Bloom',
  albumId: DEMO_ALBUM_ID,
  duration: 214,
  bitRate: 192,
  genre: 'Dream Pop',
  bpm: 104,
  key: '8A',
};

const TRACK_TITLES = [
  'Opening Static',
  'Second Wind',
  'Three of Cups',
  'Quiet Hours',
  'Five Easy Pieces',
  'Sixth Sense',
  'Closing Time',
];

export const demoTracks: Track[] = TRACK_TITLES.map((title, i) => ({
  ...demoTrack,
  id: `song-${title.toLowerCase().replace(/\s+/g, '-')}`,
  title,
  duration: 180 + i * 17,
  bpm: 96 + i * 4,
}));

export const demoSong: Song = {
  id: demoTrack.id,
  title: demoTrack.title,
  artist: demoTrack.artist,
  artistId: DEMO_ARTIST_ID,
  artists: demoArtistCredits,
  album: 'Static Bloom',
  albumId: DEMO_ALBUM_ID,
  duration: 214,
  track: 1,
  path: '/music/Nocturnal Signal/Static Bloom/01 - Opening Static.opus',
  bitRate: 192,
  size: 5_138_944,
  created: '2026-02-14T09:12:00.000Z',
  genre: 'Dream Pop',
  genres: ['Dream Pop', 'Shoegaze', 'Ambient'],
  year: 2025,
  bpm: 104,
  key: '8A',
};

export const demoSongs: Song[] = demoTracks.map((t, i) => ({
  ...demoSong,
  id: t.id,
  title: t.title,
  duration: t.duration,
  track: i + 1,
  path: `/music/Nocturnal Signal/Static Bloom/0${i + 1} - ${t.title}.opus`,
}));

/** Weights are shares of the artist's landed tracks, so they deliberately do not sum to 1. */
export const demoGenreSlices: GenreSlice[] = [
  { genre: 'Dream Pop', count: 34, weight: 0.72 },
  { genre: 'Shoegaze', count: 21, weight: 0.45 },
  { genre: 'Ambient', count: 17, weight: 0.36 },
  { genre: 'Post-Rock', count: 9, weight: 0.19 },
  { genre: 'Slowcore', count: 6, weight: 0.13 },
];

export const demoDownloadItem: DownloadItem = {
  key: 'job-4821',
  kind: 'network',
  title: 'Static Bloom',
  subtitle: 'Nocturnal Signal',
  method: 'slskd',
  stage: 'downloading',
  startedAt: Date.parse('2026-02-14T09:04:00.000Z'),
  jobId: 'job-4821',
  albumId: DEMO_ALBUM_ID,
  progress: { done: 3, total: 7 },
  percent: 43,
  bitrateKbps: 1411,
  audioFormat: 'flac',
  canRetry: false,
  canCancel: true,
  canRemove: false,
  tracks: TRACK_TITLES.map((title, i) => ({
    title,
    status: i < 3 ? 'done' : i === 3 ? 'downloading' : 'pending',
  })),
};
