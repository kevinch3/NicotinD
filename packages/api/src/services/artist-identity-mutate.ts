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
  // The STORED display name, before trimming. "Different from the target" is
  // judged against this, not against `rawName`: trimming first makes a
  // whitespace-only difference vanish before the comparison, so there was no
  // spelling of the request that could express "same name, minus the trailing
  // space" — the call was normalised into its own rejection (issue #956).
  // `"Nicole Moudaber "` is the same category of defect as
  // `Héroes Del Silencio` vs `Héroes del Silencio`, which this already handles,
  // and the album side has always been fixable via `fix_album_metadata`.
  const storedName = body.rawName ?? '';

  let kind: 'renamed' | 'merged' | 'single' | 'split';
  let resultArtistId: string | null;

  if (body.rename != null) {
    // Unlike `mergeInto` this deliberately ALLOWS an equal-normalized target —
    // a diacritic/case fix ("Los Áutenticos Decadentes" → "Los Auténticos
    // Decadentes") keeps the same artist id and just corrects the display
    // name via `aliasFix` on rescan. A different-normalized rename mints a
    // new id (a full rename). Same alias write either way.
    const rename = body.rename.trim();
    if (!rename || rename === storedName) {
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
    if (!mergeInto || mergeInto === storedName) {
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

/**
 * Read the library back after the re-bucket and say, in one sentence the
 * modal can show, if the decision did not land — `null` when it did. The
 * route answered 200 on a stored decision alone, so "Gordo/Feid" split showed
 * a green toast over an unchanged library (#1520, #1521). The stored decision
 * is kept either way: it is the curator's intent.
 */
export function verifyIdentityApplied(
  db: Database,
  body: ArtistIdentityMutateBody,
  kind: 'renamed' | 'merged' | 'single' | 'split',
): string | null {
  const raw = body.rawName?.trim() ?? '';
  const artistRow = (name: string) =>
    db
      .query<{ split_compound: number }, [string]>(
        'SELECT split_compound FROM library_artists WHERE id = ?',
      )
      .get(artistIdFor(name));

  if (kind === 'split') {
    const compound = artistRow(raw);
    const members = (body.members ?? []).map((m) => m.trim()).filter(Boolean);
    const landed =
      (!compound || compound.split_compound === 1) && members.every((m) => artistRow(m) != null);
    return landed
      ? null
      : `The split was saved, but the library still lists “${raw}” as one artist.`;
  }
  if (kind === 'single') {
    const compound = artistRow(raw);
    return compound && compound.split_compound === 0
      ? null
      : `The change was saved, but “${raw}” is still split.`;
  }
  const target = (body.rename ?? body.mergeInto ?? '').trim();
  const oldId = artistIdFor(raw);
  const stillFiled =
    oldId !== artistIdFor(target) &&
    db
      .query<{ one: number }, [string, string]>(
        'SELECT 1 AS one FROM library_songs WHERE artist_id = ? OR album_artist_id = ? LIMIT 1',
      )
      .get(oldId, oldId) != null;
  return artistRow(target) != null && !stillFiled
    ? null
    : `The change was saved, but songs are still filed under “${raw}”.`;
}
