import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileAsync } from './exec-file.js';

describe('execFileAsync', () => {
  it('resolves with stdout', async () => {
    const out = await execFileAsync(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(out.toString()).toBe('hi');
  });

  it('rejects on a non-zero exit, like execFileSync throws', async () => {
    await expect(execFileAsync(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow();
  });

  it('leaves the event loop free while the child runs (#1304)', async () => {
    let ticked = false;
    setTimeout(() => (ticked = true), 10);
    await execFileAsync(process.execPath, ['-e', 'Bun.sleepSync(200)']);
    expect(ticked).toBe(true);
  });
});

// The ingest path runs these per track; a blocking call there stalls every
// HTTP request and stream for its duration. transcode.ts keeps one memoized
// execFileSync — the boot-time `ffmpeg -version` presence probe.
describe('no blocking subprocess calls on the ingest path (#1304)', () => {
  const files = [
    'opus-artwork.ts',
    'attached-picture.ts',
    'post-download-transcode.ts',
    'acquire-watcher.ts',
  ];
  for (const file of files) {
    it(`${file} does not call execFileSync`, () => {
      const src = readFileSync(join(import.meta.dir, file), 'utf8');
      expect(src).not.toContain('execFileSync(');
    });
  }

  it('transcode.ts uses execFileSync only for the ffmpeg presence probe', () => {
    const src = readFileSync(join(import.meta.dir, 'transcode.ts'), 'utf8');
    expect(src.match(/execFileSync\(/g)).toHaveLength(1);
    expect(src).toContain("execFileSync(ffmpegBinary(), ['-version']");
  });
});
