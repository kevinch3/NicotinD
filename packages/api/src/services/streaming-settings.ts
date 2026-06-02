import type { Database } from 'bun:sqlite';

export type TranscodeFormat = 'original' | 'mp3' | 'opus' | 'aac';

export interface StreamingSettings {
  /** Master switch — when off, every stream is the original file (passthrough). */
  transcodeEnabled: boolean;
  /** Format to transcode to when transcoding is active. */
  format: Exclude<TranscodeFormat, 'original'>;
  /** Target bitrate in kbps for lossy transcodes. */
  maxBitRate: number;
  /** Transcode every stream, even when the client doesn't ask. */
  forceTranscode: boolean;
}

export const DEFAULT_STREAMING_SETTINGS: StreamingSettings = {
  transcodeEnabled: false,
  format: 'mp3',
  maxBitRate: 192,
  forceTranscode: false,
};

const KEY = 'streaming';

export function getStreamingSettings(db: Database): StreamingSettings {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return { ...DEFAULT_STREAMING_SETTINGS };
  try {
    return { ...DEFAULT_STREAMING_SETTINGS, ...(JSON.parse(row.value) as Partial<StreamingSettings>) };
  } catch {
    return { ...DEFAULT_STREAMING_SETTINGS };
  }
}

export function setStreamingSettings(
  db: Database,
  patch: Partial<StreamingSettings>,
): StreamingSettings {
  const next = { ...getStreamingSettings(db), ...patch };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}
