import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { isLicenceCode } from '@nicotind/core';
import { getDatabase } from '../db.js';
import {
  verifyAgentToken,
  AGENT_EFFECTIVE_ROLE,
  type AgentIdentity,
} from '../services/agent-tokens.js';
import { recordAudit } from '../services/audit-log.js';

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
 * **v1 tool surface is read + safe-curation.** Destructive tools (delete/merge)
 * and acquisition tools are intentionally NOT registered yet: the delete path is
 * currently inline in routes (folder-first `rmSync`), and fronting it to an LLM
 * safely wants that logic extracted into a shared, tested service first. The
 * confirm-gate + audit + refiner-cap *mechanism* is in place (see `dispatchTool`
 * and the `destructive` flag), so adding those tools is a small, safe step.
 */

export interface McpToolContext {
  db: Database;
  identity: AgentIdentity;
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
const clampLimit = (v: unknown, def: number, max: number): number => {
  const n = typeof v === 'number' ? Math.floor(v) : def;
  return Math.min(max, Math.max(1, Number.isFinite(n) ? n : def));
};

// ── Tool registry ───────────────────────────────────────────────────────────
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'search_library',
    description:
      'Search the local library for artists, albums, and songs by name (substring, case-insensitive).',
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
      const q = `%${str(args.query).trim()}%`;
      const limit = clampLimit(args.limit, 20, 50);
      const artists = db
        .query<{ id: string; name: string }, [string, number]>(
          'SELECT id, name FROM library_artists WHERE name LIKE ? COLLATE NOCASE ORDER BY album_count DESC LIMIT ?',
        )
        .all(q, limit);
      const albums = db
        .query<{ id: string; name: string; artist: string }, [string, number]>(
          'SELECT id, name, artist FROM library_albums WHERE name LIKE ? COLLATE NOCASE LIMIT ?',
        )
        .all(q, limit);
      const songs = db
        .query<{ id: string; title: string; artist: string }, [string, number]>(
          'SELECT id, title, artist FROM library_songs WHERE title LIKE ? COLLATE NOCASE AND landed_at IS NOT NULL LIMIT ?',
        )
        .all(q, limit);
      return JSON.stringify({ artists, albums, songs }, null, 2);
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
    description: 'List the songs on one album by album id, with genre and licence.',
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
            licence: string | null;
          },
          [string]
        >(
          'SELECT id, title, artist, genre, licence FROM library_songs WHERE album_id = ? ORDER BY disc, track',
        )
        .all(str(args.id));
      return JSON.stringify({ songs }, null, 2);
    },
  },
  {
    name: 'set_song_licence',
    description:
      "Set or clear a song's rights/licence code (safe curation). Pass an empty string or 'unknown' to clear. Audit-logged.",
    access: 'curate',
    inputSchema: {
      type: 'object',
      properties: {
        songId: { type: 'string' },
        licence: {
          type: 'string',
          description:
            "A LICENCE_VOCAB code (e.g. 'cc-by', 'public-domain', 'all-rights-reserved'), or '' / 'unknown' to clear.",
        },
      },
      required: ['songId', 'licence'],
    },
    handler: ({ db, identity }, args) => {
      const songId = str(args.songId);
      const raw = str(args.licence).trim().toLowerCase();
      const clear = raw === '' || raw === 'unknown';
      if (!clear && !isLicenceCode(raw)) return JSON.stringify({ error: 'invalid licence code' });
      const song = db
        .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE id = ?')
        .get(songId);
      if (!song) return JSON.stringify({ error: 'song not found' });
      const value = clear ? null : raw;
      db.run('UPDATE library_songs SET licence = ?, licence_source = ? WHERE id = ?', [
        value,
        value ? 'user' : null,
        songId,
      ]);
      recordAudit(
        db,
        { sub: identity.userId, username: `agent:${identity.tokenId}` },
        'song.licence',
        {
          targetKind: 'song',
          targetId: songId,
          detail: `${value ?? 'cleared'} (via MCP agent)`,
        },
      );
      return JSON.stringify({ ok: true, licence: value });
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

export function mcpRoutes() {
  const app = new Hono();

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
        const result = await dispatchTool({ db: getDatabase(), identity }, name, args);
        return reply(result);
      }
      default:
        return fail(-32601, `Method not found: ${body.method ?? '(none)'}`);
    }
  });

  return app;
}
