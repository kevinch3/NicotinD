import type { AlternateSource, AlternateSourcesResult } from '../services/api/api-types';

/**
 * The peer a re-source takes when nobody chooses, or null to ask instead.
 *
 * The server's ranking (coverage of the pending titles, then availability) is
 * already the answer to "which peer", so this takes its first row whatever that
 * row covers: a re-source releases the stuck peer either way, and titles the new
 * one lacks stay on the card to be re-sourced again.
 *
 * → docs/download-pipeline.md "Automatic by default, a picker on request"
 */
export function autoResourcePick(result: AlternateSourcesResult): AlternateSource | null {
  return result.alternates[0] ?? null;
}
