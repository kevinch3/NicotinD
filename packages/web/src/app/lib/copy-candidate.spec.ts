import { folderToCopy, huntToCopy, mergeCopies, copyFolderName } from './copy-candidate';
import type { FolderGroup } from './folder-utils';
import type { FolderCandidate } from '../services/api/api-types';

const folder = (over: Partial<FolderGroup> = {}): FolderGroup => ({
  username: 'peer',
  directory: 'Music\\Ennio Morricone\\The Best Of',
  uploadSpeed: 1,
  freeUploadSlots: 1,
  queueLength: 0,
  files: [
    { filename: 'Music\\Ennio Morricone\\The Best Of\\01.flac', size: 30_000_000 },
    { filename: 'Music\\Ennio Morricone\\The Best Of\\02.flac', size: 20_000_000 },
    { filename: 'Music\\Ennio Morricone\\The Best Of\\cover.jpg', size: 100 },
  ],
  ...over,
});

const hunt: FolderCandidate = {
  directory: 'Music\\Ennio Morricone\\The Best Of',
  username: 'peer',
  files: [{ filename: 'x.flac', size: 1 }],
  matchedTracks: 20,
  totalTracks: 20,
  matchPct: 100,
  format: 'FLAC',
  estimatedSizeMb: 412,
  isLive: false,
  freeUploadSlots: 0,
  queueLength: 3,
  uploadSpeed: 1,
};

describe('copy-candidate', () => {
  it('a folder counts its audio, its majority format, its size and its peer readiness', () => {
    const copy = folderToCopy(folder(), 20);
    expect(copy).toMatchObject({
      key: 'peer::Music\\Ennio Morricone\\The Best Of',
      tracks: 2,
      totalTracks: 20,
      format: 'FLAC',
      lossless: true,
      sizeBytes: 50_000_000,
      freeSlot: true,
    });
    expect(copy.matchPct).toBeUndefined();
  });

  it('a busy peer reads its queue', () => {
    expect(folderToCopy(folder({ freeUploadSlots: 0, queueLength: 7 }))).toMatchObject({
      freeSlot: false,
      queueLength: 7,
    });
  });

  it('a hunt candidate keeps its score and maps to a folder a Get can enqueue', () => {
    const copy = huntToCopy(hunt);
    expect(copy).toMatchObject({ tracks: 20, matchPct: 100, lossless: true, queueLength: 3 });
    expect(copy.folder.files).toEqual([{ filename: 'x.flac', size: 1 }]);
  });

  it('scored copies come first; a copy both lanes found keeps its score, once', () => {
    const scored = huntToCopy(hunt);
    const same = folderToCopy(folder());
    const other = folderToCopy(folder({ username: 'other' }));
    expect(mergeCopies([scored], [same, other]).map((c) => [c.username, c.matchPct])).toEqual([
      ['peer', 100],
      ['other', undefined],
    ]);
  });

  it('names a copy by its leaf folder', () => {
    expect(copyFolderName(folder())).toBe('The Best Of');
  });
});
