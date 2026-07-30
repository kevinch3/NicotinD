import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { requireCurator } from '../middleware/current-user.js';
import { getDatabase } from '../db.js';
import {
  mintAgentToken,
  listAgentTokens,
  revokeAgentToken,
  type AgentScope,
} from '../services/agent-tokens.js';
import { recordAudit } from '../services/audit-log.js';

const VALID_SCOPES: readonly AgentScope[] = ['refiner:read', 'refiner:curate'];
const MAX_NAME_LEN = 100;

/**
 * Management for MCP agent tokens (issue #232). A logged-in **curator** mints,
 * lists, and revokes tokens for the agents that will curate *their* library —
 * so these routes run behind the normal JWT auth + `requireCurator`, NOT the
 * agent-token auth (that gates `/api/mcp` itself). The minted token is capped at
 * refiner regardless of the owner's role.
 */
export function agentTokensRoutes() {
  const app = new Hono<AuthEnv>();

  // List the caller's own tokens (never the secret/hash).
  app.get('/', (c) => {
    const user = requireCurator(c);
    return c.json({ tokens: listAgentTokens(getDatabase(), user.sub) });
  });

  // Mint a token. The raw secret is returned exactly once — only its hash is
  // stored, so it can never be shown again.
  app.post('/', async (c) => {
    const user = requireCurator(c);
    const body = await c.req
      .json<{ name?: string; scope?: string; expiresInDays?: number }>()
      .catch(() => ({}) as { name?: string; scope?: string; expiresInDays?: number });

    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required', code: 'VALIDATION_ERROR' }, 400);
    if (name.length > MAX_NAME_LEN)
      return c.json({ error: 'name too long', code: 'VALIDATION_ERROR' }, 400);

    const scope = (body.scope ?? 'refiner:curate') as AgentScope;
    if (!VALID_SCOPES.includes(scope))
      return c.json({ error: 'invalid scope', code: 'VALIDATION_ERROR' }, 400);

    const now = Date.now();
    const days = body.expiresInDays;
    const expiresAt = typeof days === 'number' && days > 0 ? now + days * 24 * 3_600_000 : null;

    const db = getDatabase();
    const { id, token } = mintAgentToken(db, {
      userId: user.sub,
      name,
      scope,
      expiresAt,
      now,
    });
    recordAudit(db, user, 'agent-token.mint', {
      targetKind: 'agent-token',
      targetId: id,
      detail: `${name} (${scope})`,
    });
    // The one and only time `token` is ever returned.
    return c.json({ id, name, scope, expiresAt, token }, 201);
  });

  // Revoke one of the caller's own tokens.
  app.delete('/:id', (c) => {
    const user = requireCurator(c);
    const id = c.req.param('id');
    const db = getDatabase();
    const ok = revokeAgentToken(db, user.sub, id);
    if (!ok) return c.json({ error: 'Token not found', code: 'NOT_FOUND' }, 404);
    recordAudit(db, user, 'agent-token.revoke', { targetKind: 'agent-token', targetId: id });
    return c.json({ ok: true });
  });

  return app;
}
