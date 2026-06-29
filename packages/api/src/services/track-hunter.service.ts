import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import { buildTrackQueries, pickBestTrackFile, type TrackPick } from './track-pick.js';

const log = createLogger('track-hunter');

export interface TrackHunterOptions {
  /** Poll interval while a per-track search runs. */
  pollMs?: number;
  /** Max time to wait for a per-track search to settle. */
  timeoutMs?: number;
}

export interface TrackHuntResult {
  requested: number;
  /** Titles for which a matching file was found and enqueued. */
  enqueued: number;
  /** Titles no peer offered a clean match for. */
  misses: string[];
}

/**
 * User-facing per-track hunter (§F2/§C1). The album hunt works at folder
 * granularity and dead-ends ("No candidates") when an album exists only as loose
 * tracks scattered across peers. This searches each canonical track individually,
 * picks the healthiest clean file (shared `pickBestTrackFile`), and enqueues it —
 * so "we found N individual tracks, grab them" becomes a real action.
 */
export class TrackHunterService {
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(
    private slskd: Slskd,
    opts: TrackHunterOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Hunt every title and enqueue the best match found for each. */
  async huntAndDownload(artistName: string, titles: string[]): Promise<TrackHuntResult> {
    const picks = await Promise.all(
      titles.map(async (title) => ({ title, pick: await this.huntTrack(artistName, title) })),
    );

    const misses = picks.filter((p) => !p.pick).map((p) => p.title);

    // Group the chosen files by peer, de-duping identical filenames.
    const byPeer = new Map<string, Array<{ filename: string; size: number }>>();
    for (const { pick } of picks) {
      if (!pick) continue;
      const list = byPeer.get(pick.username) ?? [];
      if (!list.some((f) => f.filename === pick.file.filename)) list.push(pick.file);
      byPeer.set(pick.username, list);
    }

    let enqueued = 0;
    for (const [username, files] of byPeer) {
      try {
        await this.slskd.transfers.enqueue(username, files);
        enqueued += files.length;
      } catch (err) {
        log.warn({ username, err }, 'Track-hunt enqueue failed');
      }
    }

    return { requested: titles.length, enqueued, misses };
  }

  /**
   * Hunt a single track across the skewed query variants, stopping at the first
   * that yields a pick. why: a lone `"<artist> <title>"` search is silently
   * soft-banned for many phrases, so we fall through progressively skewed forms
   * (`buildTrackQueries`) the same way the album hunter's skew-search bypasses the
   * ban. A first-query hit fires no extra searches.
   */
  private async huntTrack(artistName: string, title: string): Promise<TrackPick | null> {
    for (const query of buildTrackQueries(artistName, title)) {
      const pick = await this.runQuery(query, title);
      if (pick) return pick;
    }
    return null;
  }

  /** One slskd search for a query → the best file matching `title` (or null). */
  private async runQuery(query: string, title: string): Promise<TrackPick | null> {
    let search: { id: string } | null = null;
    try {
      search = await this.slskd.searches.create(query);
    } catch (err) {
      log.debug({ query, err }, 'Track-hunt search create failed');
      return null;
    }

    try {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const state = await this.slskd.searches.get(search.id).catch(() => null);
        if (!state || state.state !== 'InProgress') break;
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
      const responses = await this.slskd.searches.getResponses(search.id).catch(() => []);
      return pickBestTrackFile(responses, title);
    } finally {
      await this.slskd.searches.delete(search.id).catch(() => {});
    }
  }
}
