import type { TransferEntry } from './transfer-types';

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

  return { label: '✗ Error', variant: 'error', disabled: true };
}

export const DEFAULT_FOLDER_LABEL = 'Download folder';

export function getFolderDownloadLabel(
  files: Array<{ username: string; filename: string }>,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
): ButtonState {
  const entries = files
    .map((f) => getStatus(f.username, f.filename))
    .filter((e): e is TransferEntry => e !== undefined);

  if (entries.some((e) => e.state.startsWith('Completed,') && e.state !== 'Completed, Succeeded'))
    return { label: '✗ Error', variant: 'error', disabled: true };

  const inProgress = entries.filter((e) => e.state === 'InProgress' || e.state === 'Initializing');
  if (inProgress.length > 0) {
    const avg = Math.round(inProgress.reduce((s, e) => s + e.percent, 0) / inProgress.length);
    return { label: `↓ ${avg}%`, variant: 'progress', disabled: true };
  }

  if (
    entries.length > 0 &&
    entries.length === files.length &&
    entries.every((e) => e.state === 'Completed, Succeeded')
  )
    return { label: '✓ Done', variant: 'done', disabled: true };

  if (isQueued || entries.some((e) => e.state.includes('Queued') || e.state === 'Requested'))
    return { label: 'Queued', variant: 'queued', disabled: true };

  return { label: DEFAULT_FOLDER_LABEL, variant: 'default', disabled: false };
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
