import { describe, expect, it } from 'bun:test';
import { cleanFolderName, groupByDirectory, ALL_SINGLES } from './auto-playlist.service.js';
import type { CompletedDownloadFile } from './metadata-fixer.js';

describe('constants', () => {
  it('exports ALL_SINGLES as "All Singles"', () => {
    expect(ALL_SINGLES).toBe('All Singles');
  });
});

describe('cleanFolderName', () => {
  it('strips bracketed quality tags', () => {
    expect(cleanFolderName('Dua Lipa - Future Nostalgia (2020) [FLAC 320kbps]')).toBe(
      'Dua Lipa - Future Nostalgia (2020)',
    );
  });

  it('strips [MP3 V0] tag and extracts leaf from backslash path', () => {
    expect(cleanFolderName('Artist\\EP Name [MP3 V0]')).toBe('EP Name');
  });

  it('strips standalone (FLAC) parens but preserves year parens', () => {
    expect(cleanFolderName('Downloads\\Some Album (2019) (FLAC)')).toBe('Some Album (2019)');
  });

  it('strips standalone (MP3) parens', () => {
    expect(cleanFolderName('Downloads\\Some Album (MP3)')).toBe('Some Album');
  });

  it('extracts leaf segment from a forward-slash path', () => {
    expect(cleanFolderName('Music/Artist/Album Name [WEB]')).toBe('Album Name');
  });

  it('passes through an already-clean name unchanged', () => {
    expect(cleanFolderName('Clean Album Name')).toBe('Clean Album Name');
  });

  it('falls back to raw input when result would be empty', () => {
    expect(cleanFolderName('[FLAC]')).toBe('[FLAC]');
  });
});

describe('groupByDirectory', () => {
  it('puts a single file in its own group', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'song.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(1);
    expect(groups.get('dir1')).toHaveLength(1);
  });

  it('groups multiple files from the same directory together', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'a.mp3' },
      { username: 'u', directory: 'dir1', filename: 'b.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(1);
    expect(groups.get('dir1')).toHaveLength(2);
  });

  it('splits a mixed batch into separate groups', () => {
    const files: CompletedDownloadFile[] = [
      { username: 'u', directory: 'dir1', filename: 'a.mp3' },
      { username: 'u', directory: 'dir2', filename: 'b.mp3' },
      { username: 'u', directory: 'dir2', filename: 'c.mp3' },
    ];
    const groups = groupByDirectory(files);
    expect(groups.size).toBe(2);
    expect(groups.get('dir1')).toHaveLength(1);
    expect(groups.get('dir2')).toHaveLength(2);
  });
});
