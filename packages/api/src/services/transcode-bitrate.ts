/**
 * How many kbps an Opus encode of a given source should get.
 *
 * **Why adaptive rather than one number.** The library's mp3 bitrate
 * distribution is cleanly bimodal — 8,153 files at 128–159 kbps and 4,589 at
 * 256+ — so a single target is wrong in one direction or the other for most of
 * the library. Encoding a 320 kbps source at 96 throws away music; encoding a
 * 128 kbps source at 128 spends bytes preserving the artifacts of the first
 * encode rather than the recording.
 *
 * **Why the top of the table is conservative.** Opus at 128 kbps is generally
 * held to be transparent for stereo music, so nothing above it buys audible
 * quality from a source that is already lossy. Going higher would mostly
 * preserve the *source encoder's* artifacts with more fidelity, which is not a
 * goal.
 *
 * Pure and table-driven on purpose: the numbers are a judgement call, and a
 * judgement call belongs somewhere it can be argued about in a test rather than
 * buried in an encoder invocation.
 *
 * Measured against the real library (2026-09-20, 13,864 candidates):
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
 * Source-bitrate buckets and the Opus rate each maps to, ordered low to high.
 *
 * `upTo` is inclusive. The last entry is the catch-all and its `upTo` is
 * `Infinity`, so the table is total by construction — there is no source
 * bitrate that falls off the end and no default hiding below the table.
 */
export const BITRATE_LADDER: ReadonlyArray<{ upTo: number; opusKbps: number }> = [
  { upTo: 127, opusKbps: 64 },
  { upTo: 159, opusKbps: 96 },
  { upTo: 255, opusKbps: 112 },
  { upTo: Infinity, opusKbps: 128 },
];

/**
 * What a lossless source gets.
 *
 * Lossless has no meaningful "source bitrate" to read — a FLAC's is a property
 * of the material, not of a quality choice — so it takes the top of the ladder
 * rather than being mapped through it. A 400 kbps FLAC and a 1,400 kbps FLAC
 * are both first-generation, and both deserve the transparent rate.
 */
export const LOSSLESS_OPUS_KBPS = 128;

/**
 * Opus kbps for a source, given its bitrate in kbps and whether it is lossless.
 *
 * **A missing or zero bitrate is a probe failure, not a quiet source.** The
 * scanner writes `0` when it could not read one, and treating that as "under
 * 128, so encode at 64" would silently crush exactly the files we know least
 * about. Unknown therefore takes the same top rate as lossless: the choice that
 * cannot make things worse, at the cost of some bytes on a handful of files.
 */
export function opusBitrateFor(sourceKbps: number | null | undefined, lossless: boolean): number {
  if (lossless) return LOSSLESS_OPUS_KBPS;
  if (sourceKbps == null || !Number.isFinite(sourceKbps) || sourceKbps <= 0) {
    return LOSSLESS_OPUS_KBPS;
  }
  for (const step of BITRATE_LADDER) {
    if (sourceKbps <= step.upTo) return step.opusKbps;
  }
  // Unreachable: the ladder's last entry is Infinity. Here so a future edit
  // that drops the catch-all fails loudly rather than returning undefined.
  throw new Error(`no bitrate bucket for ${sourceKbps} kbps — the ladder lost its catch-all`);
}

/**
 * Bytes a `kbps` Opus encode of `seconds` audio occupies, or `null` when the
 * duration is unknown.
 *
 * Decimal kilobits per second, so one second is `kbps * 1000 / 8` bytes. A dry
 * run counts **no** saving for an unknown duration rather than guessing:
 * under-reporting a saving is recoverable, over-reporting one is the mistake
 * that makes an operator size a run wrong.
 */
export function estimateOpusBytes(seconds: number | null, kbps: number): number | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * kbps * 125);
}
