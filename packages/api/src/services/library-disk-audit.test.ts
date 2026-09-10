import { describe, it, expect } from 'bun:test';
import { diskFindings, type DiskScan } from './library-disk-audit.js';

describe('diskFindings', () => {
  it('flags missing files, orphan files, and empty dirs', () => {
    const scan: DiskScan = {
      audioPaths: ['Artist/Album/01.opus', 'Artist/Album/orphan.opus'],
      emptyDirs: ['Artist/Empty Album'],
    };
    const dbPaths = ['Artist/Album/01.opus', 'Artist/Album/02-gone.opus'];
    const byRule = (r: string) => diskFindings(scan, dbPaths).filter((f) => f.rule === r);

    expect(byRule('missing_file').map((f) => f.subject)).toEqual(['Artist/Album/02-gone.opus']);
    expect(byRule('orphan_file').map((f) => f.subject)).toEqual(['Artist/Album/orphan.opus']);
    expect(byRule('empty_dir').map((f) => f.subject)).toEqual(['Artist/Empty Album']);
  });

  it('returns nothing when disk and DB agree and no empty dirs', () => {
    const scan: DiskScan = { audioPaths: ['a/b/c.opus'], emptyDirs: [] };
    expect(diskFindings(scan, ['a/b/c.opus'])).toEqual([]);
  });

  // #1079: an unindexed file whose folder already serves the same title is a
  // redundant copy (reclaim candidate), not missing music — and vice versa.
  it('splits unindexed files into redundant copies and genuine indexing gaps', () => {
    const scan: DiskScan = {
      audioPaths: [
        'LCD Soundsystem/Singles/03 - Tribulations (2).opus',
        'LCD Soundsystem/Singles/03 - Tribulations.opus',
        'Funkadelic/Singles/03 - Music For My Mother.mp3',
        'Funkadelic/Singles/03 - Music for My Mother.opus',
        'Los Tres/Album/01 - Sólo por Esta Noche.mp3',
        'Los Tres/Album/01 - Solo Por Esta Noche.opus',
        'Guy J/Esperanza/10 - Esperanza (Original Mix).opus',
        'Guy J/Esperanza/11 - 7 Steps (Original Mix).opus',
        'Guy J/Esperanza/11 - 7 Steps.opus',
        'Guy J/Esperanza/12 - Steps.opus',
        'Rafaga/Una Cerveza/01 - Una Cerveza.mp3',
        'Ráfaga/Otro/05 - Una Cerveza.mp3',
      ],
      emptyDirs: [],
      sizes: new Map([['LCD Soundsystem/Singles/03 - Tribulations.opus', 4_200_000]]),
    };
    const db = [
      'LCD Soundsystem/Singles/03 - Tribulations (2).opus',
      'Funkadelic/Singles/03 - Music For My Mother.mp3',
      'Los Tres/Album/01 - Sólo por Esta Noche.mp3',
      'Guy J/Esperanza/10 - Esperanza (Original Mix).opus',
      'Guy J/Esperanza/12 - Steps.opus',
      'Ráfaga/Otro/05 - Una Cerveza.mp3',
    ];
    const f = diskFindings(scan, db);
    const subjects = (r: string) =>
      f
        .filter((x) => x.rule === r)
        .map((x) => x.subject)
        .sort();

    expect(subjects('redundant_copy')).toEqual([
      'Funkadelic/Singles/03 - Music for My Mother.opus',
      'LCD Soundsystem/Singles/03 - Tribulations.opus',
      'Los Tres/Album/01 - Solo Por Esta Noche.opus',
    ]);
    // "7 Steps" must not fold to "Steps" (#1089), and a title twin in another
    // folder is not proof — artist folders vary, so that stays a gap to check.
    expect(subjects('orphan_file')).toEqual([
      'Guy J/Esperanza/11 - 7 Steps (Original Mix).opus',
      'Guy J/Esperanza/11 - 7 Steps.opus',
      'Rafaga/Una Cerveza/01 - Una Cerveza.mp3',
    ]);
    const lcd = f.find((x) => x.subject === 'LCD Soundsystem/Singles/03 - Tribulations.opus')!;
    expect(lcd.severity).toBe('low');
    expect(lcd.bytes).toBe(4_200_000);
    expect(lcd.message).toContain('03 - Tribulations (2).opus');
  });

  it('marks missing files high and orphan files medium severity', () => {
    const scan: DiskScan = { audioPaths: ['x.opus'], emptyDirs: [] };
    const f = diskFindings(scan, ['y.opus']);
    expect(f.find((x) => x.rule === 'missing_file')!.severity).toBe('high');
    expect(f.find((x) => x.rule === 'orphan_file')!.severity).toBe('medium');
  });
});
