import { createLogger, mergeCandidates, type AcquisitionCandidate } from '@nicotind/core';

const log = createLogger('candidate-search');

/**
 * A synchronous (request/response) metadata source that yields acquirable
 * candidates for a free-text query. `id` is the plugin id used to gate the
 * source — a new source is one adapter here + a pure mapper to
 * `AcquisitionCandidate` (see docs/source-agnostic-acquisition.md). Soulseek is
 * intentionally NOT a candidate source: its async/polled live-progress search
 * stays on `/api/search` and is blended client-side, so the network UX is kept.
 */
export interface CandidateSource {
  id: string;
  search(query: string): Promise<AcquisitionCandidate[]>;
}

/**
 * Fans a query out across every *enabled* candidate source, maps each to the
 * unified `AcquisitionCandidate` shape, and merges them into one ranked list.
 * Per-source failures are isolated (logged, dropped) so one flaky upstream never
 * empties the whole blend. Gating is registry-driven (`isEnabled`) so disabling a
 * source's plugin removes its candidates with zero route/UI changes.
 */
export class CandidateSearchAggregator {
  constructor(
    private readonly sources: CandidateSource[],
    private readonly isEnabled: (id: string) => boolean,
  ) {}

  /** Enabled source ids (for UI "N sources available" affordances). */
  enabledSourceIds(): string[] {
    return this.sources.filter((s) => this.isEnabled(s.id)).map((s) => s.id);
  }

  async search(query: string): Promise<AcquisitionCandidate[]> {
    const active = this.sources.filter((s) => this.isEnabled(s.id));
    if (active.length === 0) return [];
    const lists = await Promise.all(
      active.map((s) =>
        s.search(query).catch((err) => {
          log.warn({ source: s.id, err: err instanceof Error ? err.message : String(err) }, 'candidate source failed');
          return [] as AcquisitionCandidate[];
        }),
      ),
    );
    return mergeCandidates(...lists);
  }
}
