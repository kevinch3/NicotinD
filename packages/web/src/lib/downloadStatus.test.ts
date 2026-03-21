import { describe, expect, it } from 'bun:test';
import {
  getSingleDownloadLabel,
  getFolderDownloadLabel,
  BUTTON_CLASSES,
} from './downloadStatus';
import type { TransferEntry } from './transferTypes';

const entry = (state: TransferEntry['state'], percent = 0): TransferEntry => ({ state, percent });

describe('getSingleDownloadLabel', () => {
  const noStatus = (_u: string, _f: string): TransferEntry | undefined => undefined;

  it('returns Download when no status and not queued', () => {
    const r = getSingleDownloadLabel('u', 'f', false, noStatus);
    expect(r.label).toBe('Download');
    expect(r.variant).toBe('default');
    expect(r.disabled).toBe(false);
  });

  it('returns Queued when optimistically queued but no transfer yet', () => {
    const r = getSingleDownloadLabel('u', 'f', true, noStatus);
    expect(r.label).toBe('Queued');
    expect(r.variant).toBe('queued');
    expect(r.disabled).toBe(true);
  });

  it('shows progress percent for InProgress', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('InProgress', 42));
    expect(r.label).toBe('↓ 42%');
    expect(r.variant).toBe('progress');
    expect(r.disabled).toBe(true);
  });

  it('shows progress for Initializing', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Initializing', 0));
    expect(r.variant).toBe('progress');
  });

  it('shows Queued for Queued, Locally', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Queued, Locally'));
    expect(r.label).toBe('Queued');
    expect(r.variant).toBe('queued');
  });

  it('shows Queued for Queued, Remotely', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Queued, Remotely'));
    expect(r.label).toBe('Queued');
  });

  it('shows Queued for Requested', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Requested'));
    expect(r.label).toBe('Queued');
  });

  it('shows Done for Completed, Succeeded', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Succeeded'));
    expect(r.label).toBe('✓ Done');
    expect(r.variant).toBe('done');
    expect(r.disabled).toBe(true);
  });

  it('shows Error for Completed, Errored', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Errored'));
    expect(r.label).toBe('✗ Error');
    expect(r.variant).toBe('error');
  });

  it('shows Error for Completed, Cancelled', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Cancelled'));
    expect(r.variant).toBe('error');
  });

  it('shows Error for Completed, TimedOut', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, TimedOut'));
    expect(r.variant).toBe('error');
  });

  it('shows Error for Completed, Rejected', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Rejected'));
    expect(r.variant).toBe('error');
  });
});

describe('getFolderDownloadLabel', () => {
  it('returns Download folder when no files have status', () => {
    const files = [{ username: 'u', filename: 'a.mp3' }];
    const r = getFolderDownloadLabel(files, false, () => undefined);
    expect(r.label).toBe('Download folder');
    expect(r.variant).toBe('default');
  });

  it('returns Queued when isQueued is true and no transfer yet', () => {
    const files = [{ username: 'u', filename: 'a.mp3' }];
    const r = getFolderDownloadLabel(files, true, () => undefined);
    expect(r.label).toBe('Queued');
    expect(r.disabled).toBe(true);
  });

  it('shows average progress across in-progress files', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('InProgress', 40),
      'u:b.mp3': entry('InProgress', 60),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.label).toBe('↓ 50%');
    expect(r.variant).toBe('progress');
    expect(r.disabled).toBe(true);
  });

  it('error state wins over all others', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('Completed, Succeeded'),
      'u:b.mp3': entry('Completed, Errored'),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.variant).toBe('error');
    expect(r.disabled).toBe(true);
  });

  it('returns Done only when all files succeeded', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('Completed, Succeeded'),
      'u:b.mp3': entry('Completed, Succeeded'),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.label).toBe('✓ Done');
    expect(r.variant).toBe('done');
    expect(r.disabled).toBe(true);
  });

  it('does not return Done if only some files succeeded', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('Completed, Succeeded'),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.variant).not.toBe('done');
  });

  it('returns default when files array is empty', () => {
    const r = getFolderDownloadLabel([], false, () => undefined);
    expect(r.variant).toBe('default');
    expect(r.disabled).toBe(false);
  });
});

describe('BUTTON_CLASSES', () => {
  it('exports a class string for every variant', () => {
    const variants = ['default', 'queued', 'progress', 'done', 'error'] as const;
    for (const v of variants) {
      expect(typeof BUTTON_CLASSES[v]).toBe('string');
      expect(BUTTON_CLASSES[v].length).toBeGreaterThan(0);
    }
  });
});
