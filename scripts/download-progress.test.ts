import { describe, expect, it } from 'bun:test';
import { createProgressReporter } from './download-progress.js';

/** Feed a 103 MB download in 64 KiB chunks, the size fetch handed us. */
function simulate(isTTY: boolean): string[] {
  const out: string[] = [];
  const total = 103_000_000;
  const report = createProgressReporter({ isTTY, write: (s) => out.push(s) }, total);
  for (let done = 0; done < total;) {
    done = Math.min(total, done + 65_536);
    report(done);
  }
  return out;
}

/**
 * #1733: progress was a `\r` line per chunk. Under nohup, journald or Docker
 * logs that is ~1,600 lines (~120 KB) for one Lidarr download.
 */
describe('download progress', () => {
  it('writes at most ~one line per 10 % when stdout is not a terminal', () => {
    const lines = simulate(false).join('').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines.at(-1)).toContain('100%');
    expect(lines.join('')).not.toContain('\r');
  });

  it('keeps the live single-line bar on a terminal', () => {
    const writes = simulate(true);
    expect(writes.length).toBeGreaterThan(100);
    expect(writes.every((w) => w.startsWith('\r'))).toBe(true);
  });
});
