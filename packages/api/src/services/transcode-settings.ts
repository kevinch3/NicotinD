import { TranscodeLosslessSchema } from '@nicotind/core';

/** What `LibraryOrganizer` and `transcodeLibraryToFormat` actually consume. */
export interface ResolvedTranscodeLossless {
  enabled: boolean;
  bitRate: number;
}

/**
 * A consumer takes either the value or a reader for it.
 *
 * The reader form exists because the setting became admin-editable at runtime
 * (`downloads-settings.ts`): a consumer that captures the value at construction
 * silently ignores every change until the next restart. Callers that genuinely
 * have a fixed value — tests, offline scripts — still pass it directly.
 */
export type TranscodeLosslessSource = ResolvedTranscodeLossless | (() => ResolvedTranscodeLossless);

/** Normalize either form to a reader. */
export function readTranscodeLossless(
  source: TranscodeLosslessSource,
): () => ResolvedTranscodeLossless {
  return typeof source === 'function' ? source : () => source;
}

/**
 * Resolve `downloads.transcodeLossless` from a raw parsed config file, falling
 * back to the shipped schema default.
 *
 * The offline entry points don't build the full `NicotinDConfig` (it needs
 * `jwt`, service URLs, …), so before this they each hardcoded a fallback — and
 * all four disagreed with the schema. → docs/download-pipeline.md
 */
export function resolveTranscodeLossless(fileConfig: unknown): ResolvedTranscodeLossless {
  const downloads = (fileConfig as { downloads?: { transcodeLossless?: unknown } } | undefined)
    ?.downloads;
  // safeParse, not parse: a typo'd bitRate must fall back to the shipped
  // default rather than abort a backfill run or reach ffmpeg unvalidated.
  const parsed = TranscodeLosslessSchema.safeParse(downloads?.transcodeLossless ?? {});
  const value = parsed.success ? parsed.data : TranscodeLosslessSchema.parse({});
  return { enabled: value.enabled, bitRate: value.bitRate };
}
