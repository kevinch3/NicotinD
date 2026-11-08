/**
 * Progress for the first-run dependency download (#1733).
 *
 * On a terminal: the live `\r` bar, one rewrite per chunk. Anywhere else
 * (nohup, systemd/journald, Docker logs) each `\r` write is its own log line,
 * which made one 103 MB download ~1,600 lines, so a non-TTY gets one line per
 * 10 % step instead.
 */
export interface ProgressSink {
  isTTY: boolean;
  write: (s: string) => void;
}

export function createProgressReporter(
  sink: ProgressSink,
  totalBytes: number,
): (downloaded: number) => void {
  let lastStep = -1;
  return (downloaded) => {
    if (totalBytes <= 0) return;
    const pct = Math.floor((downloaded / totalBytes) * 100);
    const mb = (downloaded / 1_000_000).toFixed(1);
    if (sink.isTTY) {
      sink.write(`\r  Downloading... ${pct}% (${mb} MB)`);
      return;
    }
    const step = Math.floor(pct / 10);
    if (step === lastStep) return;
    lastStep = step;
    sink.write(`  Downloading... ${pct}% (${mb} MB)\n`);
  };
}
