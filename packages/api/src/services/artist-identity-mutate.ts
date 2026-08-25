/**
 * Artist-identity mutation (rename / merge / one-act / split) — extracted out
 * of `POST /api/library/artists/identity` in routes/library.ts (issue #339),
 * mirroring services/library-deletion.ts's shape (issue #232): the MCP agent
 * surface needs the same tested path an HTTP request uses instead of a second
 * copy of the decision logic living in routes/mcp.ts.
 *
 * `dataDir` is an explicit param rather than a closure, matching
 * library-deletion.ts's `DeletionDeps` — the two callers (the HTTP route and
 * the MCP tool) each own their own wiring. `runSync` (the library rescan) and
 * `recordAudit` stay caller-side, same as `deleteOne`/`deleteAlbum`: this
 * function only performs the identity-store write + curation carry, not the
 * side effects each caller wants to sequence differently.
 */
import type { Database } from 'bun:sqlite';
import { normalizeArtistForGrouping } from './album-grouping.js';
import { upsertArtistIdentity, upsertArtistAlias } from './artist-identity-store.js';
import { carryArtistCuration } from './artist-curation-carry.js';
import { artistIdFor } from './library-scanner.js';

export interface ArtistIdentityMutateDeps {
  dataDir?: string;
}

export interface ArtistIdentityMutateBody {
  rawName?: string;
  decision?: 'single' | 'split';
  members?: string[];
  mergeInto?: string;
  rename?: string;
}

export type ArtistIdentityMutateResult =
  | {
      ok: true;
      kind: 'renamed' | 'merged' | 'single' | 'split';
      /** The artist id the caller should land on. `null` for a split — there
       *  is no single destination once the compound is broken apart. */
      artistId: string | null;
    }
  | { ok: false; error: string; status: 400 };

/** Apply one rename/merge/single/split decision for `body.rawName`. Does not
 *  resync the library or record an audit entry — the caller does both, since
 *  the HTTP route and the MCP tool sequence them differently (the route
 *  formats a richer detail string; a future caller might batch resyncs). */
export function mutateArtistIdentity(
  db: Database,
  deps: ArtistIdentityMutateDeps,
  body: ArtistIdentityMutateBody,
): ArtistIdentityMutateResult {
  const rawName = body.rawName?.trim();
  if (!rawName) return { ok: false, error: 'rawName required', status: 400 };

  let kind: 'renamed' | 'merged' | 'single' | 'split';
  let resultArtistId: string | null;

  if (body.rename != null) {
    // Unlike `mergeInto` this deliberately ALLOWS an equal-normalized target —
    // a diacritic/case fix ("Los Áutenticos Decadentes" → "Los Auténticos
    // Decadentes") keeps the same artist id and just corrects the display
    // name via `aliasFix` on rescan. A different-normalized rename mints a
    // new id (a full rename). Same alias write either way.
    const rename = body.rename.trim();
    if (!rename || rename === rawName) {
      return { ok: false, error: 'rename must be a non-empty, different name', status: 400 };
    }
    upsertArtistAlias(db, {
      aliasNorm: normalizeArtistForGrouping(rawName),
      canonicalName: rename,
      source: 'user',
    });
    kind = 'renamed';
    resultArtistId = artistIdFor(rename);
  } else if (body.mergeInto != null) {
    const mergeInto = body.mergeInto.trim();
    if (!mergeInto || mergeInto === rawName) {
      return { ok: false, error: 'mergeInto must be a different artist name', status: 400 };
    }
    // A same-normalized target ("Héroes Del Silencio" → "Héroes del Silencio")
    // used to be refused here. That refusal blocked the only artist duplication
    // this library actually accumulates — measured over the 2,000 most recent
    // prod tracks, 12 of 13 real duplicate identities were case/accent pairs,
    // and the one pair the guard *did* accept was a false positive (issue #707).
    // The write is identical either way: one alias row keyed on the normalized
    // raw name. Only the reported `kind` differs, and it reports what actually
    // happened — a canonical-spelling fix on one artist — so the audit ledger
    // can still tell a respelling from a genuine two-artist merge.
    const sameNorm = normalizeArtistForGrouping(mergeInto) === normalizeArtistForGrouping(rawName);
    upsertArtistAlias(db, {
      aliasNorm: normalizeArtistForGrouping(rawName),
      canonicalName: mergeInto,
      source: 'user',
    });
    kind = sameNorm ? 'renamed' : 'merged';
    resultArtistId = artistIdFor(mergeInto);
  } else if (body.decision === 'single') {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor(rawName),
      rawName,
      decision: 'single',
      source: 'user',
    });
    kind = 'single';
    resultArtistId = artistIdFor(rawName);
  } else if (body.decision === 'split') {
    const members = (body.members ?? []).map((m) => m.trim()).filter(Boolean);
    if (members.length < 2) {
      return { ok: false, error: 'split requires at least 2 member names', status: 400 };
    }
    upsertArtistIdentity(db, {
      artistKey: artistIdFor(rawName),
      rawName,
      decision: 'split',
      members,
      source: 'user',
    });
    // The compound is hidden after a split; there's no single artist to land on.
    kind = 'split';
    resultArtistId = null;
  } else {
    return {
      ok: false,
      error: 'decision (single|split), mergeInto, or rename required',
      status: 400,
    };
  }

  // A rename/merge re-mints the artist id, and every artist-scoped side table
  // is keyed on the old one with no FK to notice — carry curation BEFORE the
  // rescan re-buckets, and never clobber whatever the destination already has
  // (issue #305).
  if (resultArtistId) {
    const fromId = artistIdFor(rawName);
    carryArtistCuration(db, deps.dataDir, {
      fromId,
      toId: resultArtistId,
      fromKey: normalizeArtistForGrouping(rawName),
      toKey: normalizeArtistForGrouping(body.rename ?? body.mergeInto ?? rawName),
    });
  }

  return { ok: true, kind, artistId: resultArtistId };
}
