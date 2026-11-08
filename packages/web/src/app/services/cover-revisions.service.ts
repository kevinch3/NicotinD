import { Injectable, inject, signal, untracked, type WritableSignal } from '@angular/core';
import { coverUrl, type CoverKind, type CoverRef } from '../lib/cover-url';
import { PreservedCoversService } from './preserved-covers.service';

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
  // One signal per entity, not one map signal: a reader depends on its own
  // entity's rev only, so a push for another album re-runs nothing that reads
  // this one — no lock-screen re-send, no launcher re-publish, no palette
  // re-probe (docs/cache-invalidation.md "The web half").
  private readonly revs = new Map<string, WritableSignal<number>>();
  private readonly preserved = inject(PreservedCoversService);

  /** Record revisions; a rev no newer than the one held is ignored. */
  raise(changes: Iterable<CoverRevision>): void {
    for (const c of changes) {
      const slot = this.slot(key(c.kind, c.id));
      if (c.rev > untracked(slot)) slot.set(c.rev);
    }
  }

  /** The newest pushed rev for one entity (0 when none). Reactive, per entity. */
  live(kind: CoverKind, id: string | null | undefined): number {
    return id ? this.slot(key(kind, id))() : 0;
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
    if (!ref) return undefined;
    // Offline, an album's preserved cover (#1658): an object URL, which
    // ServerConfigService.apiUrl passes through untouched. Artist portraits are
    // never preserved.
    if (ref.kind === 'album' && this.preserved.offline()) {
      const local = this.preserved.urlFor(`album:${ref.id}`);
      if (local) return local;
    }
    return coverUrl({ ...ref, coverRev: this.effective(ref) }, size, token);
  }

  private slot(k: string): WritableSignal<number> {
    let s = this.revs.get(k);
    if (!s) this.revs.set(k, (s = signal(0)));
    return s;
  }
}

const key = (kind: CoverKind, id: string): string => `${kind}:${id}`;
