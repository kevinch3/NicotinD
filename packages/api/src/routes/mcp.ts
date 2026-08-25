import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import {
  verifyAgentToken,
  AGENT_EFFECTIVE_ROLE,
  type AgentIdentity,
} from '../services/agent-tokens.js';
import { recordAudit } from '../services/audit-log.js';
import { deleteAlbum, deleteOne } from '../services/library-deletion.js';
import { mutateArtistIdentity } from '../services/artist-identity-mutate.js';
import { mutateSongGenre } from '../services/song-genre-mutate.js';
import {
  createCurationFlag,
  isFlagTargetKind,
  listOpenCurationFlags,
} from '../services/curation-flags.js';
import { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';
import { tokenize, matchesAllTokens, rankBy } from '../services/search-tokens.js';

/**
 * MCP server for external LLM/agents (issue #232), served **inside the Hono app**
 * (one deployment, works over the desktop's 127.0.0.1 backend and self-hosted web
 * alike). Speaks the MCP `initialize` / `tools/list` / `tools/call` methods over
 * a single POST endpoint as hand-rolled JSON-RPC 2.0 — no heavy SDK dependency,
 * consistent with the project's dependency discipline and its small tool surface.
 *
 * Auth is the **agent token** (not the JWT that gates the rest of the API): the
 * bearer is verified per request and capped at the `refiner` role, so curation
 * works and server-admin does not. Every write tool is audit-logged; destructive
 * tools additionally require an explicit `confirm: true` argument.
 *
 * **v1 tool surface was read + safe-curation only; destructive tools now ship
 * too** (`delete_album`/`delete_song`/`merge_artist`): the deletion path used
 * to be inline in routes/library.ts (folder-first `rmSync`), extracted into
 * `services/library-deletion.ts` so both the HTTP routes and this MCP surface
 * call the same tested implementation; the artist rename/merge/split decision
 * logic (issue #339) got the same treatment into
 * `services/artist-identity-mutate.ts`, and the song-genre write (issue #677)
 * into `services/song-genre-mutate.ts`. Each destructive tool is
 * `access: 'curate'` + `destructive: true`, so `checkToolAccess` already
 * enforces the refiner-scope + `confirm: true` gate before the handler runs,
 * and each writes the same `recordAudit` action name the HTTP route uses.
 */

export interface McpToolContext {
  db: Database;
  identity: AgentIdentity;
  /** Deletion dependencies (issue #232) — musicDir + a debounced share rescan. */
  deletion: { musicDir?: string; shareRescan: ShareRescanScheduler };
  /** Artist-identity dependencies (issue #339) — dataDir for curation-carry,
   *  plus a library resync so a merge/rename takes effect immediately, same
   *  as the HTTP route's `await runSync()`. */
  artistIdentity: { dataDir?: string; runSync?: () => Promise<void> };
  /** Song-genre dependencies (issue #677) — musicDir for the file-tag mirror. */
  songGenre: { musicDir?: string };
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (MCP `inputSchema`). */
  inputSchema: Record<string, unknown>;
  /** `read` tools are GET-equivalent; `curate` tools require the `:curate` scope. */
  access: 'read' | 'curate';
  /** Destructive tools require `args.confirm === true` at call time. */
  destructive?: boolean;
  handler: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<string> | string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A tool's list argument, tolerating the single-value form callers still send. */
const strList = (v: unknown, fallback: string): string[] => {
  const list = Array.isArray(v) ? v.map(str) : [fallback];
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
};
const MAX_MERGE_BATCH = 50;
const clampLimit = (v: unknown, def: number, max: number): number => {
  const n = typeof v === 'number' ? Math.floor(v) : def;
  return Math.min(max, Math.max(1, Number.isFinite(n) ? n : def));
};

// ── Tool registry ───────────────────────────────────────────────────────────
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'search_library',
    description:
      'Search the local library for artists, albums, and songs by name. Matching is accent- and case-insensitive and ANDs every word of the query, so "Americo" finds "Américo" and "heroes silencio" finds "Héroes del Silencio".',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against names/titles.' },
        limit: { type: 'number', description: 'Max results per kind (1–50, default 20).' },
      },
      required: ['query'],
    },
    handler: ({ db }, args) => {
      // issue #706: this used a raw `LIKE ? COLLATE NOCASE`, and SQLite's NOCASE
      // collation is ASCII-only — it folds neither diacritics nor a non-ASCII
      // upper case, so "Americo" (and even "AMÉRICO") missed "Américo" entirely.
      // An agent reading that as "the artist does not exist" mints a duplicate
      // instead of merging into it. Route through the same tokenize/fold matcher
      // every other search surface uses, so the agent and the UI find the same
      // things: SQL does the cheap row gating, JS does the folded token match.
      const limit = clampLimit(args.limit, 20, 50);
      const tokens = tokenize(str(args.query));
      if (tokens.length === 0) {
        return JSON.stringify({ artists: [], albums: [], songs: [] }, null, 2);
      }
      const artists = db
        .query<{ id: string; name: string }, []>(
          'SELECT id, name FROM library_artists ORDER BY album_count DESC',
        )
        .all()
        .filter((r) => matchesAllTokens(r.name, tokens))
        .slice(0, limit);
      const albums = db
        .query<{ id: string; name: string; artist: string }, []>(
          'SELECT id, name, artist FROM library_albums',
        )
        .all()
        // Match over "name + artist" so "soda cancion" resolves, same as the UI.
        .filter((r) => matchesAllTokens(`${r.name} ${r.artist}`, tokens))
        .sort(rankBy(tokens, (r) => r.name))
        .slice(0, limit);
      const songs = db
        .query<{ id: string; title: string; artist: string }, []>(
          'SELECT id, title, artist FROM library_songs WHERE landed_at IS NOT NULL',
        )
        .all()
        .filter((r) => matchesAllTokens(`${r.title} ${r.artist}`, tokens))
        .sort(rankBy(tokens, (r) => r.title))
        .slice(0, limit);
      return JSON.stringify({ artists, albums, songs }, null, 2);
    },
  },
  {
    name: 'list_recent_songs',
    description:
      'List recently-landed songs, newest first. Optionally filter to only songs missing a genre.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (1–100, default 25).' },
        offset: { type: 'number', description: 'Rows to skip, for paging (default 0).' },
        missingGenre: { type: 'boolean', description: 'Only songs with no genre set.' },
      },
    },
    handler: ({ db }, args) => {
      const limit = clampLimit(args.limit, 25, 100);
      const offset = Math.max(0, Math.floor(typeof args.offset === 'number' ? args.offset : 0));
      const missingGenre = args.missingGenre === true;
      const where = missingGenre
        ? "s.landed_at IS NOT NULL AND (s.genre IS NULL OR s.genre = '')"
        : 's.landed_at IS NOT NULL';
      const songs = db
        .query<
          {
            id: string;
            title: string;
            artist: string;
            albumId: string;
            album: string | null;
            genre: string | null;
            landedAt: number | null;
          },
          [number, number]
        >(
          `SELECT s.id, s.title, s.artist, s.album_id AS albumId, a.name AS album,
                  s.genre, s.landed_at AS landedAt
           FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
           WHERE ${where}
           ORDER BY s.landed_at DESC, s.id LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
      return JSON.stringify({ songs, limit, offset }, null, 2);
    },
  },
  {
    name: 'get_artist',
    description: "Get one artist and their albums by the artist's id.",
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The artist id.' } },
      required: ['id'],
    },
    handler: ({ db }, args) => {
      const id = str(args.id);
      const artist = db
        .query<{ id: string; name: string }, [string]>(
          'SELECT id, name FROM library_artists WHERE id = ?',
        )
        .get(id);
      if (!artist) return JSON.stringify({ error: 'artist not found' });
      const albums = db
        .query<{ id: string; name: string; year: number | null; genre: string | null }, [string]>(
          'SELECT id, name, year, genre FROM library_albums WHERE artist_id = ? ORDER BY year',
        )
        .all(id);
      return JSON.stringify({ ...artist, albums }, null, 2);
    },
  },
  {
    name: 'get_album_tracks',
    description: 'List the songs on one album by album id, with their genre.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The album id.' } },
      required: ['id'],
    },
    handler: ({ db }, args) => {
      const songs = db
        .query<
          {
            id: string;
            title: string;
            artist: string;
            genre: string | null;
          },
          [string]
        >(
          'SELECT id, title, artist, genre FROM library_songs WHERE album_id = ? ORDER BY disc, track',
        )
        .all(str(args.id));
      return JSON.stringify({ songs }, null, 2);
    },
  },
  {
    name: 'set_song_genre',
    description:
      "Set a song's genre(s) (safe curation). Pass one genre or a ';'-separated list, primary first. " +
      "mode 'append' (default) adds to the song's existing genres; 'replace' makes these the primary set " +
      'and keeps it that way across rescans. Audit-logged.',
    access: 'curate',
    inputSchema: {
      type: 'object',
      properties: {
        songId: { type: 'string' },
        genre: {
          type: 'string',
          description: "One genre, or a ';'-separated list with the primary genre first.",
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description: "'append' (default) adds; 'replace' overrides the song's primary set.",
        },
      },
      required: ['songId', 'genre'],
    },
    handler: async ({ db, identity, songGenre }, args) => {
      const songId = str(args.songId);
      const mode = str(args.mode) === 'replace' ? 'replace' : 'append';
      const result = await mutateSongGenre(db, songGenre, songId, {
        genre: str(args.genre),
        mode,
      });
      if (!result.ok) return JSON.stringify({ error: result.error });
      recordAudit(
        db,
        { sub: identity.userId, username: `agent:${identity.tokenId}` },
        'song.genre',
        {
          targetKind: 'song',
          targetId: songId,
          detail: `${mode}: ${result.genres.join(';')} (via MCP agent)`,
        },
      );
      return JSON.stringify({ ok: true, genres: result.genres });
    },
  },
  {
    name: 'flag_for_review',
    description:
      'Flag one artist, album, or song as needing a human decision, with a reason. Use this instead of guessing when a fix has no unambiguous answer — a b2b DJ credit naming two acts, an identity you cannot resolve confidently. Changes no library data. Re-flagging the same target updates the open flag rather than adding another.',
    access: 'curate',
    inputSchema: {
      type: 'object',
      properties: {
        targetKind: { type: 'string', enum: ['artist', 'album', 'song'] },
        targetId: {
          type: 'string',
          description: 'The artist/album/song id, or the raw name for an unresolvable artist.',
        },
        reason: {
          type: 'string',
          description: 'What the ambiguity is and what a human needs to decide.',
        },
      },
      required: ['targetKind', 'targetId', 'reason'],
    },
    handler: ({ db, identity }, args) => {
      const targetKind = str(args.targetKind);
      if (!isFlagTargetKind(targetKind)) {
        return JSON.stringify({ error: 'targetKind must be artist, album, or song' });
      }
      const targetId = str(args.targetId).trim();
      const reason = str(args.reason).trim();
      if (!targetId || !reason)
        return JSON.stringify({ error: 'targetId and reason are required' });

      const actor = `agent:${identity.tokenId}`;
      const { flag, created } = createCurationFlag(db, {
        targetKind,
        targetId,
        reason,
        createdBy: actor,
      });
      // Audited like the other writes: a flag is inert for the library, but it
      // does put a task on a person, which is worth a trace.
      recordAudit(db, { sub: identity.userId, username: actor }, 'curation.flag', {
        targetKind,
        targetId,
        detail: `${created ? 'flagged' : 'updated'}: ${reason} (via MCP agent)`,
      });
      return JSON.stringify({ ok: true, id: flag.id, created });
    },
  },
  {
    name: 'list_review_flags',
    description:
      'List the open human-review flags, oldest first — what a previous pass could not decide alone.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (1–100, default 25).' } },
    },
    handler: ({ db }, args) =>
      JSON.stringify(
        { flags: listOpenCurationFlags(db, clampLimit(args.limit, 25, 100)) },
        null,
        2,
      ),
  },
  {
    name: 'delete_song',
    description:
      'Permanently delete one song file from disk and the library (destructive). Requires confirm: true.',
    access: 'curate',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        songId: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true to proceed.' },
      },
      required: ['songId', 'confirm'],
    },
    handler: async ({ db, identity, deletion }, args) => {
      const songId = str(args.songId);
      const result = await deleteOne(db, songId, deletion);
      if (!result.ok) return JSON.stringify({ error: result.error });
      recordAudit(
        db,
        { sub: identity.userId, username: `agent:${identity.tokenId}` },
        'song.delete',
        { targetKind: 'song', targetId: songId, detail: '(via MCP agent)' },
      );
      return JSON.stringify({ ok: true });
    },
  },
  {
    name: 'delete_album',
    description:
      'Permanently delete an album (all its songs) from disk and the library (destructive). Requires confirm: true.',
    access: 'curate',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        albumId: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true to proceed.' },
      },
      required: ['albumId', 'confirm'],
    },
    handler: async ({ db, identity, deletion }, args) => {
      const albumId = str(args.albumId);
      const result = await deleteAlbum(db, albumId, deletion);
      if (!result) return JSON.stringify({ error: 'album not found' });
      recordAudit(
        db,
        { sub: identity.userId, username: `agent:${identity.tokenId}` },
        'album.delete',
        {
          targetKind: 'album',
          targetId: albumId,
          detail: `${result.albumRow ? `${result.albumRow.artist} — ${result.albumRow.name}, ` : ''}${result.deletedCount} song(s) deleted (via MCP agent)`,
        },
      );
      return JSON.stringify({
        ok: result.ok,
        deletedCount: result.deletedCount,
        failedCount: result.failedCount,
      });
    },
  },
  {
    name: 'merge_artist',
    description:
      'Merge one or more artists (by their current display names) into another, canonical artist name (destructive — re-buckets all their songs under the target name on the next library scan). Also fixes a case/accent duplicate ("Héroes Del Silencio" → "Héroes del Silencio", "Los Rodriguez" → "Los Rodríguez"): that is one artist stored under two spellings, and it is reported back as kind "renamed". Pass rawName for one, or rawNames for a batch sharing one target. Requires confirm: true.',
    access: 'curate',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        rawName: {
          type: 'string',
          description: 'The current display name of the artist to merge away.',
        },
        rawNames: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Several display names to merge into the same target in one call (1–50). Use instead of rawName.',
        },
        mergeInto: { type: 'string', description: 'The canonical artist name to merge into.' },
        confirm: { type: 'boolean', description: 'Must be true to proceed.' },
      },
      required: ['mergeInto', 'confirm'],
    },
    handler: async ({ db, identity, artistIdentity }, args) => {
      // One root cause routinely produces several corrupted spellings of the
      // same artist (issue #680): a batch shares one confirm and one resync
      // instead of paying for both per name.
      const names = strList(args.rawNames, str(args.rawName));
      if (names.length === 0) return JSON.stringify({ error: 'rawName or rawNames required' });
      if (names.length > MAX_MERGE_BATCH) {
        return JSON.stringify({ error: `at most ${MAX_MERGE_BATCH} names per call` });
      }
      const mergeInto = str(args.mergeInto);
      // A case/accent duplicate routes to the rename path (issue #707), so one
      // batch can hold both kinds — each name carries the kind it actually got.
      const merged: Array<{ rawName: string; kind: string }> = [];
      const failed: Array<{ rawName: string; error: string }> = [];
      // Every name in a batch lands on the same target, so `artistId` stays a
      // single top-level value — the shape the one-name form already returned.
      let artistId: string | null = null;
      for (const rawName of names) {
        const result = mutateArtistIdentity(db, artistIdentity, { rawName, mergeInto });
        if (!result.ok) {
          failed.push({ rawName, error: result.error });
          continue;
        }
        artistId = result.artistId;
        merged.push({ rawName, kind: result.kind });
        // One audit row per merge, not one per call: `targetId` stays the raw
        // name, so the log is still greppable per artist after a batch. The verb
        // is the kind that actually happened, so a curator reading the ledger can
        // tell a respelling from a genuine two-artist merge.
        const verb = result.kind === 'renamed' ? 'rename' : 'merge';
        recordAudit(
          db,
          { sub: identity.userId, username: `agent:${identity.tokenId}` },
          'artist.identity',
          {
            targetKind: 'artist',
            targetId: rawName,
            detail: `${verb} → ${mergeInto} (via MCP agent)`,
          },
        );
      }
      // A rescan is minutes of work; run it once, and only if something changed.
      if (merged.length > 0 && artistIdentity.runSync) await artistIdentity.runSync();
      const kinds = new Set(merged.map((m) => m.kind));
      return JSON.stringify(
        {
          ok: failed.length === 0,
          // 'mixed' when a batch did both, rather than picking one label and
          // mislabelling the rest. Per-name kinds are always in `merged`.
          kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
          artistId,
          merged,
          failed,
        },
        null,
        2,
      );
    },
  },
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

export interface DispatchResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const err = (text: string): DispatchResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * Pure guard: does this scope + these args permit running `tool`? Returns a
 * refusal message, or null when the call may proceed. Enforces, in order: a
 * `curate` tool needs the `:curate` scope (a read-only token is refused), and a
 * `destructive` tool needs `args.confirm === true`. Extracted so both gates are
 * unit-testable independent of the (currently non-destructive) v1 registry.
 */
export function checkToolAccess(
  tool: Pick<McpTool, 'name' | 'access' | 'destructive'>,
  scope: AgentIdentity['scope'],
  args: Record<string, unknown>,
): string | null {
  if (tool.access === 'curate' && scope !== 'refiner:curate') {
    return 'This token is read-only; curation tools require a refiner:curate token.';
  }
  if (tool.destructive && args.confirm !== true) {
    return `"${tool.name}" is destructive — pass confirm: true to proceed.`;
  }
  return null;
}

/**
 * Run one tool call under an agent identity: resolve the tool, apply
 * `checkToolAccess`, then run its handler. Returns an MCP tool result; never
 * throws (a handler error becomes an `isError` result).
 */
export async function dispatchTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return err(`Unknown tool: ${name}`);
  const refusal = checkToolAccess(tool, ctx.identity.scope, args);
  if (refusal) return err(refusal);
  try {
    const text = await tool.handler(ctx, args);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return err(`Tool error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── JSON-RPC 2.0 transport ────────────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_INFO = { name: 'nicotind-mcp', version: '1' };
const PROTOCOL_VERSION = '2024-11-05';

export function mcpRoutes(
  musicDir?: string,
  notifyLibraryChanged?: () => Promise<void>,
  dataDir?: string,
  runSync?: () => Promise<void>,
) {
  const app = new Hono();
  // Debounced the same way the HTTP delete routes are (share-rescan-scheduler.ts):
  // a burst of MCP deletes triggers one slskd rescan, not one per file.
  const shareRescan = new ShareRescanScheduler(async () => {
    await notifyLibraryChanged?.();
  });

  app.post('/', async (c) => {
    // Agent-token auth — NOT the app JWT. Capped at refiner.
    const authz = c.req.header('Authorization') ?? '';
    const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    const identity = verifyAgentToken(getDatabase(), bearer);
    if (!identity) {
      return c.json({ error: 'invalid or revoked agent token' }, 401);
    }

    const body = await c.req.json<JsonRpcRequest>().catch(() => ({}) as JsonRpcRequest);
    const id = body.id ?? null;
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id, error: { code, message } });

    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          // Surfaced so an agent knows what it can do without a round-trip.
          instructions: `You are connected to a NicotinD music library as a ${AGENT_EFFECTIVE_ROLE} (curation, no server admin). Scope: ${identity.scope}.`,
        });
      case 'ping':
        return reply({});
      case 'notifications/initialized':
        // Notification: no id, no response body expected.
        return c.body(null, 204);
      case 'tools/list':
        return reply({
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const params = body.params ?? {};
        const name = str(params.name);
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const result = await dispatchTool(
          {
            db: getDatabase(),
            identity,
            deletion: { musicDir, shareRescan },
            artistIdentity: { dataDir, runSync },
            songGenre: { musicDir },
          },
          name,
          args,
        );
        return reply(result);
      }
      default:
        return fail(-32601, `Method not found: ${body.method ?? '(none)'}`);
    }
  });

  return app;
}
