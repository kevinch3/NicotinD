import type { LibraryFormat } from './library-format.js';

/**
 * How many kbps an encode of a given source should get, per target format.
 *
 * **Why adaptive rather than one number.** The library's mp3 bitrate
 * distribution is cleanly bimodal — 8,153 files at 128–159 kbps and 4,589 at
 * 256+ — so a single target is wrong in one direction or the other for most of
 * the library. Encoding a 320 kbps source at 96 throws away music; encoding a
 * 128 kbps source at 128 spends bytes preserving the artifacts of the first
 * encode rather than the recording.
 *
 * Pure and table-driven on purpose: the numbers are a judgement call, and a
 * judgement call belongs somewhere it can be argued about in a test rather than
 * buried in an encoder invocation.
 *
 * **Why a ladder per format rather than one shared table.** The numbers are
 * calibrated to a codec, not to a source: Opus at 96 kbps is roughly mp3 at
 * 160. Reusing Opus's rungs for an mp3 target would encode most of a library
 * at a little over half the rate its own table asks for. A format arrives here
 * with its own ladder or it does not arrive.
 *
 * Measured against the real library (2026-09-20, 13,864 candidates), Opus:
 *
 * | source | files | now | → Opus | after | saved |
 * | --- | --- | --- | --- | --- | --- |
 * | < 128 kbps | 80 | 0.34 GiB | 64 | 0.13 GiB | 0.21 |
 * | 128–159 | 8,153 | 30.19 GiB | 96 | 21.85 GiB | 8.34 |
 * | 160–255 | 1,038 | 5.76 GiB | 112 | 3.26 GiB | 2.50 |
 * | 256+ | 4,589 | 41.84 GiB | 128 | 16.57 GiB | 25.27 |
 * | **total** | **13,864** | **78.22 GiB** | | **41.85 GiB** | **36.4** |
 */

/**
 * One format's mapping from source bitrate to target rate.
 *
 * `upTo` is inclusive. The last step is the catch-all and its `upTo` is
 * `Infinity`, so a ladder is total by construction — there is no source bitrate
 * that falls off the end and no default hiding below the table.
 *
 * `losslessKbps` is what a lossless source gets. Lossless has no meaningful
 * "source bitrate" to read — a FLAC's is a property of the material, not of a
 * quality choice — so it takes the top of the ladder rather than being mapped
 * through it. A 400 kbps FLAC and a 1,400 kbps FLAC are both first-generation,
 * and both deserve the transparent rate.
 */
export interface BitrateLadder {
  steps: ReadonlyArray<{ upTo: number; targetKbps: number }>;
  losslessKbps: number;
}

/**
 * The ladder each target format uses.
 *
 * Total over `LibraryFormat`, so a format cannot join the registry in
 * `library-format.ts` without bringing a calibrated ladder with it.
 *
 * Opus's top rung is 128: Opus at 128 kbps is generally held to be transparent
 * for stereo music, so nothing above it buys audible quality from a source that
 * is already lossy. Going higher would mostly preserve the *source encoder's*
 * artifacts with more fidelity, which is not a goal.
 */
export const LADDERS: Record<LibraryFormat, BitrateLadder> = {
  opus: {
    steps: [
      { upTo: 127, targetKbps: 64 },
      { upTo: 159, targetKbps: 96 },
      { upTo: 255, targetKbps: 112 },
      { upTo: Infinity, targetKbps: 128 },
    ],
    losslessKbps: 128,
  },
  // mp3's rungs sit ABOVE Opus's at every step, and above the source's own
  // number in the lower buckets. That is not a mistake and it is the reason a
  // ladder cannot be shared: mp3 is the less efficient codec, so matching
  // *perceived* quality costs more bits. Roughly, Opus 64 ≈ mp3 128, Opus 96 ≈
  // mp3 160, Opus 112 ≈ mp3 192, Opus 128 ≈ mp3 256 (LAME V0, ~245 VBR, is the
  // usual transparency mark).
  //
  // Note the invariant the Opus ladder is tested against — "never a rate above
  // the source for a lossy file" — is deliberately NOT generalised. It holds
  // for Opus because Opus is more efficient than everything converted into it.
  // Applying it here would cap a 128 kbps source at 128 kbps of mp3 and throw
  // away music on every file. A same-format source never reaches the ladder at
  // all: the pass skips anything already in the target format.
  mp3: {
    steps: [
      { upTo: 127, targetKbps: 128 },
      { upTo: 159, targetKbps: 160 },
      { upTo: 255, targetKbps: 192 },
      { upTo: Infinity, targetKbps: 256 },
    ],
    losslessKbps: 256,
  },
};

/**
 * Target kbps for a source, given its bitrate in kbps and whether it is lossless.
 *
 * **A missing or zero bitrate is a probe failure, not a quiet source.** The
 * scanner writes `0` when it could not read one, and treating that as "under
 * 128, so encode at 64" would silently crush exactly the files we know least
 * about. Unknown therefore takes the same top rate as lossless: the choice that
 * cannot make things worse, at the cost of some bytes on a handful of files.
 */
export function bitrateFor(
  format: LibraryFormat,
  sourceKbps: number | null | undefined,
  lossless: boolean,
): number {
  const ladder = LADDERS[format];
  if (lossless) return ladder.losslessKbps;
  if (sourceKbps == null || !Number.isFinite(sourceKbps) || sourceKbps <= 0) {
    return ladder.losslessKbps;
  }
  for (const step of ladder.steps) {
    if (sourceKbps <= step.upTo) return step.targetKbps;
  }
  // Unreachable: the ladder's last entry is Infinity. Here so a future edit
  // that drops the catch-all fails loudly rather than returning undefined.
  throw new Error(
    `no bitrate bucket for ${sourceKbps} kbps — the ${format} ladder lost its catch-all`,
  );
}

/**
 * Bytes a `kbps` encode of `seconds` audio occupies, or `null` when the
 * duration is unknown.
 *
 * Decimal kilobits per second, so one second is `kbps * 1000 / 8` bytes — the
 * same arithmetic whatever the codec, since the rate is the rate. A dry run
 * counts **no** saving for an unknown duration rather than guessing:
 * under-reporting a saving is recoverable, over-reporting one is the mistake
 * that makes an operator size a run wrong.
 */
export function estimateEncodedBytes(seconds: number | null, kbps: number): number | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * kbps * 125);
}
