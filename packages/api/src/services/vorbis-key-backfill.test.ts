import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ffmpegAvailable } from './transcode.js';
import { planVorbisKeyHeal } from './audio-tags.js';
import { reservedDirsFor } from './library-paths.js';
import { backfillVorbisKeys } from './vorbis-key-backfill.js';

let musicDir: string;
beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'nicotind-vkeys-'));
});
afterEach(() => rmSync(musicDir, { recursive: true, force: true }));

function opus(rel: string, ...meta: string[]): string {
  const path = join(musicDir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libopus'];
  for (const m of meta) args.push('-metadata', m);
  expect(spawnSync('ffmpeg', [...args, path]).status).toBe(0);
  return path;
}

describe.if(ffmpegAvailable())('backfillVorbisKeys (#1250, #1231)', () => {
  function tree() {
    return {
      spaced: opus(
        'A/Album/01.opus',
        'MusicBrainz Artist Id=a1',
        'album_artist=X',
        'ALBUM ARTIST=X',
      ),
      clean: opus('A/Album/02.opus', 'TITLE=clean'),
      conflict: opus(
        'B/Album/01.opus',
        'RELEASESTATUS=withdrawn',
        'MusicBrainz Album Status=official',
      ),
      staged: opus('.downloads/peer/01.opus', 'MusicBrainz Artist Id=staged'),
    };
  }

  it('reports without writing by default, and never walks a reserved dir', async () => {
    const files = tree();
    const report = await backfillVorbisKeys({
      musicDir,
      reserved: reservedDirsFor(),
      apply: false,
    });
    expect(report.scanned).toBe(3);
    expect(report.affected).toBe(1);
    expect(report.byKey).toEqual({ 'ALBUM ARTIST': 1, 'MUSICBRAINZ ARTIST ID': 1 });
    expect(report.conflicts).toEqual([
      { path: 'B/Album/01.opus', spaced: 'MUSICBRAINZ ALBUM STATUS', canonical: 'RELEASESTATUS' },
    ]);
    expect((await planVorbisKeyHeal(files.spaced))?.metadata.length).toBeGreaterThan(0);
  });

  it('--apply heals the affected file, verified from disk, and leaves the rest', async () => {
    const files = tree();
    const report = await backfillVorbisKeys({ musicDir, reserved: reservedDirsFor(), apply: true });
    expect(report.failed).toEqual([]);
    expect((await planVorbisKeyHeal(files.spaced))?.metadata).toEqual([]);
    expect((await planVorbisKeyHeal(files.conflict))?.conflicts).toHaveLength(1);
    expect((await planVorbisKeyHeal(files.staged))?.metadata.length).toBeGreaterThan(0);
    // A second run finds nothing left to do.
    const again = await backfillVorbisKeys({ musicDir, reserved: reservedDirsFor(), apply: true });
    expect(again.affected).toBe(0);
  });

  it('applies a curated resolution under its dir, and reports one that matched nothing (#1283)', async () => {
    const files = tree();
    const resolutions = [
      { dir: 'B/Album', spaced: 'MUSICBRAINZ ALBUM STATUS', keep: 'spaced' as const },
      { dir: 'Nowhere/Album', spaced: 'ALBUM ARTIST', keep: 'canonical' as const },
    ];
    const report = await backfillVorbisKeys({
      musicDir,
      reserved: reservedDirsFor(),
      apply: true,
      resolutions,
    });
    expect(report.failed).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.unusedResolutions).toEqual([resolutions[1]]);
    const after = await planVorbisKeyHeal(files.conflict);
    expect(after).toEqual({ metadata: [], conflicts: [] });
    const { parseFile } = await import('music-metadata');
    const status = (await parseFile(files.conflict)).native.vorbis?.filter((t) =>
      /STATUS/i.test(t.id),
    );
    expect(status?.map((t) => [t.id.toUpperCase(), t.value])).toEqual([
      ['RELEASESTATUS', 'official'],
    ]);
  });
});
