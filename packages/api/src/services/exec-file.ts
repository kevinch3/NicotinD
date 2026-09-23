import { execFile } from 'node:child_process';

/**
 * Run a binary (ffmpeg/ffprobe) without blocking the event loop and resolve
 * with its stdout. The async counterpart of `execFileSync`, which froze every
 * HTTP request and stream for the length of each call on the ingest path
 * (#1304). Rejects on a non-zero exit, a timeout or a spawn failure, like
 * `execFileSync` throws.
 */
export function execFileAsync(
  file: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'buffer',
        timeout: opts.timeout ?? 0,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}
