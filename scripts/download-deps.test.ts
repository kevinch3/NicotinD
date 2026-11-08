import { describe, expect, it } from 'bun:test';
import { createProgressReporter, type ProgressStream } from './download-deps';

/**
 * A first-run install under nohup, systemd or Docker logs got ~120 KB of
 * `\r`-redrawn progress for one 103 MB download (#1733). Redirected stdout must
 * log a handful of lines instead of redrawing for every chunk.
 */
const TOTAL_BYTES = 103 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function fakeStdout(isTTY: boolean): ProgressStream & {
  chunks: string[];
  text: string;
  lines: string[];
} {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    get text() {
      return chunks.join('');
    },
    get lines() {
      // journald and Docker split records on \r as well as on \n
      return this.text.split(/[\r\n]+/u).filter((line) => line.length > 0);
    },
  };
  return stream;
}

function feed(report: (downloaded: number) => void): void {
  for (let downloaded = 0; downloaded < TOTAL_BYTES; downloaded += CHUNK_BYTES) {
    report(Math.min(downloaded + CHUNK_BYTES, TOTAL_BYTES));
  }
}

describe('dependency download progress', () => {
  it('logs at most a dozen lines when stdout is not a TTY', () => {
    const stdout = fakeStdout(false);

    feed(createProgressReporter(stdout, TOTAL_BYTES));

    expect(stdout.lines.length).toBeLessThanOrEqual(12);
    expect(stdout.text).not.toContain('\r');
    expect(stdout.lines.at(-1)).toContain('100%');
  });

  it('keeps the live bar on a TTY', () => {
    const stdout = fakeStdout(true);

    feed(createProgressReporter(stdout, TOTAL_BYTES));

    expect(stdout.text.startsWith('\r  Downloading... ')).toBe(true);
    expect(stdout.text).not.toContain('\n');
    expect(stdout.chunks.length).toBeGreaterThan(100);
  });

  it('logs nothing when the size is unknown', () => {
    const stdout = fakeStdout(false);

    feed(createProgressReporter(stdout, 0));

    expect(stdout.chunks).toEqual([]);
  });
});
