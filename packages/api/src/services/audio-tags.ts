import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { renameSync, unlinkSync } from 'node:fs';
import { createLogger } from '@nicotind/core';

const log = createLogger('audio-tags');

export const ID3_EXTS = new Set(['.mp3']);
export const VORBIS_EXTS = new Set(['.flac', '.ogg', '.opus']);
export const AUDIO_EXTS = new Set([
  ...ID3_EXTS,
  ...VORBIS_EXTS,
  '.m4a',
  '.wav',
  '.aac',
  '.aiff',
  '.alac',
]);

export interface AudioTags {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  trackNumber?: number;
  year?: number;
  genre?: string;
  /** Beats per minute (TBPM / Vorbis `BPM`). Written by on-demand track analysis. */
  bpm?: number;
  compilation?: boolean;
  /** AcoustID track UUID. Doubles as a "we've already fingerprinted this" marker. */
  acoustIdId?: string;
  /** MusicBrainz recording ID. */
  mbRecordingId?: string;
  /** MusicBrainz release (album) ID. */
  mbReleaseId?: string;
}

type NodeId3UserText = { description: string; value: string };
type NodeId3Api = {
  read: (filepath: string) => Record<string, unknown> | false | undefined;
  update: (tags: Record<string, unknown>, filepath: string) => boolean;
};
type MusicMetadataApi = {
  parseFile: (
    path: string,
    opts?: { duration?: boolean },
  ) => Promise<{
    common: {
      artist?: string;
      albumartist?: string;
      album?: string;
      title?: string;
      track?: { no?: number | null };
      year?: number;
      acoustid_id?: string;
      musicbrainz_recordingid?: string;
      musicbrainz_albumid?: string;
    };
  }>;
};

// MusicBrainz Picard's TXXX description conventions — kept consistent so other
// tools (Picard, beets, Lidarr, Jellyfin) round-trip the same values.
const TXXX_ACOUSTID = 'Acoustid Id';
const TXXX_MB_RECORDING = 'MusicBrainz Track Id';
const TXXX_MB_RELEASE = 'MusicBrainz Album Id';

function readUserText(raw: Record<string, unknown>, description: string): string | undefined {
  const list = raw.userDefinedText as NodeId3UserText[] | undefined;
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((u) => u?.description?.toLowerCase() === description.toLowerCase());
  return hit ? pickString(hit.value) : undefined;
}

let nodeId3Promise: Promise<NodeId3Api | null> | null = null;
let mmPromise: Promise<MusicMetadataApi | null> | null = null;

async function getNodeId3(): Promise<NodeId3Api | null> {
  if (!nodeId3Promise) {
    nodeId3Promise = import('node-id3')
      .then((mod) => (mod.default ?? mod) as unknown as NodeId3Api)
      .catch(() => null);
  }
  return nodeId3Promise;
}
async function getMusicMetadata(): Promise<MusicMetadataApi | null> {
  if (!mmPromise) {
    mmPromise = import('music-metadata')
      .then((mod) => mod as unknown as MusicMetadataApi)
      .catch(() => null);
  }
  return mmPromise;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function parseTrackNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/^\d+/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function parseYear(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/(19|20)\d{2}/);
    if (m) return Number(m[0]);
  }
  return undefined;
}

export async function readAudioTags(filepath: string): Promise<AudioTags> {
  const ext = extname(filepath).toLowerCase();
  if (ID3_EXTS.has(ext)) {
    const id3 = await getNodeId3();
    if (!id3) return {};
    try {
      const raw = id3.read(filepath);
      if (!raw || typeof raw !== 'object') return {};
      const d = raw as Record<string, unknown>;
      return {
        artist: pickString(d.artist),
        albumArtist: pickString(d.performerInfo) ?? pickString(d.band),
        album: pickString(d.album),
        title: pickString(d.title),
        trackNumber: parseTrackNumber(d.trackNumber),
        year: parseYear(d.year),
        compilation: d.TCMP === '1' || d.compilation === '1',
        acoustIdId: readUserText(d, TXXX_ACOUSTID),
        mbRecordingId: readUserText(d, TXXX_MB_RECORDING),
        mbReleaseId: readUserText(d, TXXX_MB_RELEASE),
      };
    } catch {
      return {};
    }
  }
  if (VORBIS_EXTS.has(ext) || ext === '.m4a') {
    const mm = await getMusicMetadata();
    if (!mm) return {};
    try {
      const parsed = await mm.parseFile(filepath, { duration: false });
      const c = parsed.common;
      return {
        artist: pickString(c.artist),
        albumArtist: pickString(c.albumartist),
        album: pickString(c.album),
        title: pickString(c.title),
        trackNumber: c.track?.no ?? undefined,
        year: c.year,
        acoustIdId: pickString(c.acoustid_id),
        mbRecordingId: pickString(c.musicbrainz_recordingid),
        mbReleaseId: pickString(c.musicbrainz_albumid),
      };
    } catch {
      return {};
    }
  }
  return {};
}

export async function writeAudioTags(filepath: string, tags: AudioTags): Promise<boolean> {
  const ext = extname(filepath).toLowerCase();
  if (ID3_EXTS.has(ext)) return writeId3Tags(filepath, tags);
  if (VORBIS_EXTS.has(ext) || ext === '.m4a') return writeFfmpegTags(filepath, tags);
  return false;
}

async function writeId3Tags(filepath: string, tags: AudioTags): Promise<boolean> {
  const id3 = await getNodeId3();
  if (!id3) return false;
  const update: Record<string, unknown> = {};
  if (tags.album !== undefined) update.album = tags.album;
  if (tags.albumArtist !== undefined) update.performerInfo = tags.albumArtist;
  if (tags.artist !== undefined) update.artist = tags.artist;
  if (tags.title !== undefined) update.title = tags.title;
  if (tags.trackNumber !== undefined) update.trackNumber = String(tags.trackNumber);
  if (tags.year !== undefined) update.year = String(tags.year);
  if (tags.genre !== undefined) update.genre = tags.genre;
  if (tags.bpm !== undefined) update.bpm = String(tags.bpm);
  if (tags.compilation) update.TCMP = '1';

  const userText: NodeId3UserText[] = [];
  if (tags.acoustIdId) userText.push({ description: TXXX_ACOUSTID, value: tags.acoustIdId });
  if (tags.mbRecordingId)
    userText.push({ description: TXXX_MB_RECORDING, value: tags.mbRecordingId });
  if (tags.mbReleaseId) userText.push({ description: TXXX_MB_RELEASE, value: tags.mbReleaseId });
  if (userText.length > 0) update.userDefinedText = userText;

  if (Object.keys(update).length === 0) return true;
  try {
    return id3.update(update, filepath);
  } catch (err) {
    log.warn({ err, filepath }, 'ID3 update failed');
    return false;
  }
}

function writeFfmpegTags(filepath: string, tags: AudioTags): Promise<boolean> {
  const tmpPath = filepath + '.nicotind.tmp';
  const metaArgs: string[] = [];
  if (tags.album !== undefined) metaArgs.push('-metadata', `ALBUM=${tags.album}`);
  if (tags.albumArtist !== undefined) metaArgs.push('-metadata', `ALBUMARTIST=${tags.albumArtist}`);
  if (tags.artist !== undefined) metaArgs.push('-metadata', `ARTIST=${tags.artist}`);
  if (tags.title !== undefined) metaArgs.push('-metadata', `TITLE=${tags.title}`);
  if (tags.trackNumber !== undefined) metaArgs.push('-metadata', `TRACK=${tags.trackNumber}`);
  if (tags.year !== undefined) metaArgs.push('-metadata', `DATE=${tags.year}`);
  if (tags.genre !== undefined) metaArgs.push('-metadata', `GENRE=${tags.genre}`);
  if (tags.bpm !== undefined) metaArgs.push('-metadata', `BPM=${tags.bpm}`);
  if (tags.compilation) metaArgs.push('-metadata', 'COMPILATION=1');
  if (tags.acoustIdId) metaArgs.push('-metadata', `ACOUSTID_ID=${tags.acoustIdId}`);
  if (tags.mbRecordingId) metaArgs.push('-metadata', `MUSICBRAINZ_TRACKID=${tags.mbRecordingId}`);
  if (tags.mbReleaseId) metaArgs.push('-metadata', `MUSICBRAINZ_ALBUMID=${tags.mbReleaseId}`);
  if (metaArgs.length === 0) return Promise.resolve(true);

  const args = ['-y', '-i', filepath, '-map_metadata', '0', ...metaArgs, '-c', 'copy', tmpPath];
  return new Promise<boolean>((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
    proc.on('error', () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      resolve(false);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          renameSync(tmpPath, filepath);
          resolve(true);
        } catch {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* ignore */
          }
          resolve(false);
        }
      } else {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        resolve(false);
      }
    });
  });
}

export function isUnknownLike(value: string | undefined): boolean {
  if (!value) return true;
  const n = value
    .toLowerCase()
    .replace(/[\[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    n === '' ||
    n === 'unknown' ||
    n === 'unknown artist' ||
    n === 'unknown album' ||
    n === 'unknown title' ||
    n === 'various' ||
    n === 'various artists'
  );
}

export function normalizeTagValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const lower = trimmed.toLowerCase();
  if (
    lower === 'unknown' ||
    lower === 'unknown artist' ||
    lower === 'unknown album' ||
    lower === 'unknown title'
  )
    return undefined;
  return trimmed;
}
