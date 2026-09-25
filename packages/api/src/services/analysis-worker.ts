/**
 * Worker body for the local key and tempo estimators (see track-analysis.ts).
 * The ffmpeg decode was already off-thread; the DSP after it was not: a
 * Krumhansl–Schmuckler chroma pass or a music-tempo run is seconds of pure
 * CPU per track, and on prod an enrichment backlog of `key` work blocked the
 * event loop ~4 s out of every ~4 s. Same functions, different thread.
 */
import { detectKey } from './key-detection.js';

declare const self: Worker;

type Request =
  | { kind: 'key'; samples: Float32Array; sampleRate: number }
  | { kind: 'tempo'; samples: Float32Array };

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    if (req.kind === 'key') {
      postMessage({ ok: true, key: detectKey(req.samples, req.sampleRate) });
      return;
    }
    const mod = (await import('music-tempo')) as { default?: unknown };
    const MusicTempo = (mod.default ?? mod) as new (s: Float32Array) => { tempo: number };
    postMessage({ ok: true, tempo: new MusicTempo(req.samples).tempo });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
