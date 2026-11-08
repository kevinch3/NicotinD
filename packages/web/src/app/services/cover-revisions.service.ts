import { Injectable, signal, untracked } from '@angular/core';
import { coverUrl, type CoverKind, type CoverRef } from '../lib/cover-url';

/** One entity whose cover bytes changed, with its new persisted `cover_rev`. */
export interface CoverRevision {
  kind: CoverKind;
  id: string;
  rev: number;
}

/**
 * The live cover-revision overlay (#1666): the newest `cover_rev` this session
 * has heard of per album / artist, so a cover URL re-keys the moment its bytes
 * change — on every surface, including ones holding an older DTO snapshot (the
 * player queue, a grid loaded before the change).
 *
 * Fed from two places: `artwork.changed` (LibraryEventsService, for a change
 * made anywhere) and a mutation's `{ ok, coverRev }` answer (for the acting
 * client, without waiting for the stream). The effective rev is
 * `max(ref.coverRev, overlay)`; neither side ever rewinds it.
 *
 * A replay gap leaves the overlay in place. Revs are monotonic per entity on
 * the server (`library_cover_rev_floor`), so an entry is never wrong, only
 * possibly incomplete — dropping it would rewind every snapshot surface to its
 * older DTO rev. What the gap missed arrives with the next DTO read, which the
 * gap's resync makes fresh (docs/cache-invalidation.md "Cover identity").
 */
@Injectable({ providedIn: 'root' })
export class CoverRevisionsService {
  private readonly revs = signal<ReadonlyMap<string, number>>(new Map());

  /** Record revisions; a rev no newer than the one held is ignored. */
  raise(changes: Iterable<CoverRevision>): void {
    const next = new Map(untracked(this.revs));
    let moved = false;
    for (const c of changes) {
      const k = key(c.kind, c.id);
      if (c.rev <= (next.get(k) ?? 0)) continue;
      next.set(k, c.rev);
      moved = true;
    }
    // No new map for nothing new: every cover URL reading the overlay would re-render.
    if (moved) this.revs.set(next);
  }

  /** The newest pushed rev for one entity (0 when none). Reactive. */
  live(kind: CoverKind, id: string | null | undefined): number {
    return id ? (this.revs().get(key(kind, id)) ?? 0) : 0;
  }

  /** The rev a URL should carry: the DTO's, or a newer one heard since. Reactive. */
  effective(ref: CoverRef): number {
    return Math.max(ref.coverRev, this.live(ref.kind, ref.id));
  }

  /**
   * The relative cover URL at the effective rev, or undefined for no cover.
   * Reading it inside a computed or a template re-renders on a pushed rev.
   */
  url(ref: CoverRef | null | undefined, size: number, token: string | null): string | undefined {
    return ref ? coverUrl({ ...ref, coverRev: this.effective(ref) }, size, token) : undefined;
  }
}

const key = (kind: CoverKind, id: string): string => `${kind}:${id}`;
