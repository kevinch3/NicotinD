import type { TransferEntry } from './transferTypes';

export type ButtonVariant = 'default' | 'queued' | 'progress' | 'done' | 'error';

export interface ButtonState {
  label: string;
  variant: ButtonVariant;
  disabled: boolean;
}

export const BUTTON_CLASSES: Record<ButtonVariant, string> = {
  default: 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
  queued:  'bg-zinc-700 text-zinc-400 opacity-75',
  progress:'bg-blue-900/60 text-blue-300',
  done:    'bg-green-900/60 text-green-300',
  error:   'bg-red-900/60 text-red-300',
};

export function getSingleDownloadLabel(
  username: string,
  filename: string,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
): ButtonState {
  const e = getStatus(username, filename);

  if (!e) {
    if (isQueued) return { label: 'Queued', variant: 'queued', disabled: true };
    return { label: 'Download', variant: 'default', disabled: false };
  }

  const { state, percent } = e;

  if (state === 'InProgress' || state === 'Initializing')
    return { label: `↓ ${percent}%`, variant: 'progress', disabled: true };

  if (state === 'Queued, Locally' || state === 'Queued, Remotely' || state === 'Requested')
    return { label: 'Queued', variant: 'queued', disabled: true };

  if (state === 'Completed, Succeeded')
    return { label: '✓ Done', variant: 'done', disabled: true };

  // Completed, Cancelled / TimedOut / Errored / Rejected
  return { label: '✗ Error', variant: 'error', disabled: true };
}

/**
 * Derives folder-level button state by aggregating across all files.
 *
 * `files` must carry username per-item because network result file objects
 * don't include it (username lives on the parent result/group). The caller
 * must pre-map: `group.files.map(f => ({ username: group.username, filename: f.filename }))`.
 *
 * Note: FolderBrowser's "Download all" button has no optimistic-queued signal
 * because `addDownloading` lives in the search store and FolderBrowser doesn't
 * have access to it. The button will remain at its default state for up to one
 * poll cycle (~3s) after clicking. This is a known, acceptable gap.
 */
export function getFolderDownloadLabel(
  files: Array<{ username: string; filename: string }>,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
): ButtonState {
  const entries = files
    .map((f) => getStatus(f.username, f.filename))
    .filter((e): e is TransferEntry => e !== undefined);

  // Any failure wins
  if (entries.some((e) => e.state.startsWith('Completed,') && e.state !== 'Completed, Succeeded'))
    return { label: '✗ Error', variant: 'error', disabled: true };

  // Average progress across in-flight files
  const inProgress = entries.filter((e) => e.state === 'InProgress' || e.state === 'Initializing');
  if (inProgress.length > 0) {
    const avg = Math.round(inProgress.reduce((s, e) => s + e.percent, 0) / inProgress.length);
    return { label: `↓ ${avg}%`, variant: 'progress', disabled: true };
  }

  // All files completed successfully (every file must have a succeeded status)
  if (
    entries.length > 0 &&
    entries.length === files.length &&
    entries.every((e) => e.state === 'Completed, Succeeded')
  )
    return { label: '✓ Done', variant: 'done', disabled: true };

  // Optimistic or slskd-confirmed queued
  if (isQueued || entries.some((e) => e.state.includes('Queued') || e.state === 'Requested'))
    return { label: 'Queued', variant: 'queued', disabled: true };

  return { label: DEFAULT_FOLDER_LABEL, variant: 'default', disabled: false };
}

export const DEFAULT_FOLDER_LABEL = 'Download folder';

/**
 * Returns true if `path` (for `username`) is covered by any queued entry.
 * Coverage: exact match OR the stored entry is a parent directory.
 * Handles both `\` (Windows/Soulseek) and `/` as path separators.
 */
export function isPathEffectivelyQueued(
  username: string,
  path: string,
  downloadedFolders: Set<string>,
): boolean {
  const prefix = `${username}:`;
  return Array.from(downloadedFolders).some((k) => {
    if (!k.startsWith(prefix)) return false;
    const queued = k.slice(prefix.length);
    return (
      path === queued ||
      path.startsWith(queued + '\\') ||
      path.startsWith(queued + '/')
    );
  });
}
