/**
 * One coherent fake library, reused by every story.
 *
 * The catalog reads as a product rather than 36 unrelated placeholder strings only if
 * the same artist, album and tracks recur across components. Everything here satisfies
 * the real interface — never `as any` — so a story stops compiling when a type changes,
 * which is the point of having stories in `typecheck`.
 */
import type { LyricsDto, WaveformData } from '@nicotind/core';
import type { Track } from '../../app/services/player.service';
import type { ArtistCredit, ProvenanceRecord, Song } from '../../app/services/api/api-types';
import type { DownloadItem } from '../../app/lib/download-groups';
import type { GenreSlice } from '../../app/components/genre-radar/genre-radar.component';

export const DEMO_ARTIST_ID = 'artist-nocturnal-signal';
export const DEMO_ALBUM_ID = 'album-static-bloom';

/**
 * The demo track's length. Exported because the silent stream the player
 * stories hand the `<audio>` element has to be exactly this long — the player
 * rejects a browser duration far from the API-known one. See `story-audio.ts`.
 */
export const DEMO_TRACK_SECONDS = 214;

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
  duration: DEMO_TRACK_SECONDS,
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
  duration: DEMO_TRACK_SECONDS,
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

/**
 * Synced lyrics for the demo track, so the Now Playing Lyrics tab has a line to
 * highlight rather than its empty state. The timestamps are spread over the
 * whole track: wherever a story parks playback, one line is the active one.
 */
export const demoLyrics: LyricsDto = {
  plain: 'Static on the opening band\nA held breath, then the room lets go',
  synced: [
    '[00:12.00]Static on the opening band',
    '[00:26.40]A held breath, then the room lets go',
    '[00:41.10]Every light in the hall goes soft',
    '[01:04.00]We are only here for the sound',
    '[01:38.50]Hold it, hold it, let it break',
    '[02:22.00]And the last note stays in the wall',
  ].join('\n'),
  source: 'storybook',
  customized: false,
  updatedAt: Date.parse('2026-02-14T09:12:00.000Z'),
  offsetMs: 0,
};

/**
 * Waveform artifact for the demo track (`GET /api/peaks/:id`), which is what
 * turns the Now Playing seek bar into the envelope strip rather than its plain
 * fallback.
 *
 * Generated, not written out: `peaks` is 200 interleaved min/max pairs and
 * `bands` is one six-level row every half second, which as a literal would be
 * ~2,700 numbers of noise in a fixture file.
 */
function buildDemoWaveform(): WaveformData {
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  // Three swells with a fade in and out — enough shape that a strip drawing the
  // envelope upside down or ignoring `min` is visible at a glance.
  const levelAt = (t: number): number =>
    0.18 + 0.72 * Math.abs(Math.sin(t * Math.PI * 3)) * Math.min(1, 4 * t * (1 - t) + 0.2);

  const pairs = 200;
  const peaks: number[] = [];
  for (let i = 0; i < pairs; i++) {
    const level = levelAt(i / (pairs - 1));
    peaks.push(round(-level), round(level));
  }

  const frameRate = 2;
  const frames = DEMO_TRACK_SECONDS * frameRate;
  const bands: number[][] = [];
  for (let f = 0; f < frames; f++) {
    const level = levelAt(f / (frames - 1));
    // Bass-heavy, as most of this catalog's fixture material claims to be.
    bands.push([1, 0.95, 0.8, 0.65, 0.45, 0.3].map((share) => round(level * share)));
  }

  return { version: 1, duration: DEMO_TRACK_SECONDS, peaks, frameRate, bands };
}

export const demoWaveform: WaveformData = buildDemoWaveform();

/**
 * Processing history for the track-info sheet. Two entries so the timeline
 * renders as a list rather than a single item, and so the ordering is visible.
 */
export const demoProvenance: ProvenanceRecord[] = [
  {
    action: 'genre',
    appliedAt: 1_770_000_000_000,
    detail: { from: 'Pop', to: 'Dream Pop', reason: 'discogs release match' },
  },
  {
    action: 'bpm',
    appliedAt: 1_769_000_000_000,
    detail: { to: '104', reason: 'essentia rhythm' },
  },
];
