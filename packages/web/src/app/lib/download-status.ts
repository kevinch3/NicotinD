import type { TransferEntry } from './transfer-types';
import type { Translator } from './relative-time';

export type ButtonVariant = 'default' | 'queued' | 'progress' | 'done' | 'error';

type LabelKind = 'download' | 'queued' | 'downloading' | 'done' | 'error' | 'downloadFolder';

/** i18n key per label. Exported so specs assert the key, not the English. */
export const DOWNLOAD_STATUS_KEYS: Record<LabelKind, string> = {
  download: 'acquire.download',
  queued: 'acquire.queued',
  downloading: 'acquire.downloading',
  done: 'acquire.done',
  error: 'acquire.errorShort',
  downloadFolder: 'acquire.downloadFolder',
};

/** English fallback, byte-identical to the pre-i18n wording (see relative-time.ts
 *  for the translator-as-param pattern this module follows). */
const ENGLISH_LABELS: Record<LabelKind, string> = {
  download: 'Download',
  queued: 'Queued',
  downloading: 'Downloading…',
  done: '✓ Done',
  error: '✗ Error',
  downloadFolder: 'Download folder',
};

function labelFor(kind: LabelKind, t?: Translator): string {
  return t ? t(DOWNLOAD_STATUS_KEYS[kind]) : ENGLISH_LABELS[kind];
}

export interface ButtonState {
  label: string;
  variant: ButtonVariant;
  disabled: boolean;
}

export const BUTTON_CLASSES: Record<ButtonVariant, string> = {
  default: 'bg-theme-surface-2 text-theme-secondary hover:bg-theme-hover',
  queued: 'bg-theme-surface-2 text-theme-muted opacity-75',
  progress: 'status-progress',
  done: 'status-done',
  error: 'status-error',
};

export function getSingleDownloadLabel(
  username: string,
  filename: string,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
  t?: Translator,
): ButtonState {
  const e = getStatus(username, filename);

  if (!e) {
    if (isQueued) return { label: labelFor('queued', t), variant: 'queued', disabled: true };
    return { label: labelFor('download', t), variant: 'default', disabled: false };
  }

  const { state, percent } = e;

  if (state === 'InProgress' || state === 'Initializing') {
    // The unified feed carries no per-file percent (#663); "↓ N%" renders only
    // when one exists. Symbol + number is language-neutral, so it stays untranslated.
    if (typeof percent === 'number')
      return { label: `↓ ${percent}%`, variant: 'progress', disabled: true };
    return { label: labelFor('downloading', t), variant: 'progress', disabled: true };
  }

  if (state === 'Queued, Locally' || state === 'Queued, Remotely' || state === 'Requested')
    return { label: labelFor('queued', t), variant: 'queued', disabled: true };

  if (state === 'Completed, Succeeded')
    return { label: labelFor('done', t), variant: 'done', disabled: true };

  return { label: labelFor('error', t), variant: 'error', disabled: true };
}

export const DEFAULT_FOLDER_LABEL = ENGLISH_LABELS.downloadFolder;

export function getFolderDownloadLabel(
  files: Array<{ username: string; filename: string }>,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
  t?: Translator,
): ButtonState {
  const entries = files
    .map((f) => getStatus(f.username, f.filename))
    .filter((e): e is TransferEntry => e !== undefined);

  if (entries.some((e) => e.state.startsWith('Completed,') && e.state !== 'Completed, Succeeded'))
    return { label: labelFor('error', t), variant: 'error', disabled: true };

  const inProgress = entries.filter((e) => e.state === 'InProgress' || e.state === 'Initializing');
  if (inProgress.length > 0) {
    // Average only over files that actually carry a percent — the unified feed
    // carries none (#663), and counting them as 0 skews the number.
    const withPercent = inProgress.filter((e) => typeof e.percent === 'number');
    if (withPercent.length === 0)
      return { label: labelFor('downloading', t), variant: 'progress', disabled: true };
    const avg = Math.round(
      withPercent.reduce((s, e) => s + (e.percent ?? 0), 0) / withPercent.length,
    );
    return { label: `↓ ${avg}%`, variant: 'progress', disabled: true };
  }

  if (
    entries.length > 0 &&
    entries.length === files.length &&
    entries.every((e) => e.state === 'Completed, Succeeded')
  )
    return { label: labelFor('done', t), variant: 'done', disabled: true };

  if (isQueued || entries.some((e) => e.state.includes('Queued') || e.state === 'Requested'))
    return { label: labelFor('queued', t), variant: 'queued', disabled: true };

  return { label: labelFor('downloadFolder', t), variant: 'default', disabled: false };
}

export function isPathEffectivelyQueued(
  username: string,
  path: string,
  downloadedFolders: Set<string>,
): boolean {
  const normPath = path.replace(/\//g, '\\');
  const prefix = `${username}:`;
  for (const k of downloadedFolders) {
    if (!k.startsWith(prefix)) continue;
    const queued = k.slice(prefix.length).replace(/\//g, '\\');
    if (normPath === queued || normPath.startsWith(queued + '\\')) return true;
  }
  return false;
}

/**
 * Render the dominant bitrate + format as a compact pill for the download
 * card. Pure: missing inputs return '' so callers can drop the chip with
 * `@if (formatQuality(item.bitrateKbps, item.audioFormat))`.
 *
 *   formatQuality(320, 'MP3')   → '320 kbps'
 *   formatQuality(1411, 'FLAC') → 'FLAC · 1411 kbps'   (lossless → show codec)
 *   formatQuality(192, 'opus')  → '192 kbps'           (lowercase from ffprobe
 *                                                      — UI surfaces the kbps)
 *   formatQuality(undefined, 'FLAC') → 'FLAC'          (lossless without kbps)
 *   formatQuality(null, null)   → ''                   (chip hidden)
 */
export function formatQuality(bitrateKbps?: number | null, format?: string | null): string {
  const fmt = (format ?? '').trim();
  const upper = fmt.toUpperCase();
  const isLossless = upper === 'FLAC' || upper === 'WAV' || upper === 'ALAC' || upper === 'APE';
  const kbps = typeof bitrateKbps === 'number' && bitrateKbps > 0 ? bitrateKbps : null;
  if (kbps != null && isLossless) return `${upper} · ${kbps} kbps`;
  if (kbps != null && fmt) return `${kbps} kbps`;
  if (kbps != null) return `${kbps} kbps`;
  if (fmt) return upper;
  return '';
}
