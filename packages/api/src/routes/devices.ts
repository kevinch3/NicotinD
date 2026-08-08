import { Hono } from 'hono';
import { hostname } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { asRole, CODE_ALPHABET, CODE_LENGTH } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { candidateUrls } from '../services/pairing-urls.js';
import { recordAudit } from '../services/audit-log.js';
import type { RemoteAccess } from '../services/tailscale.js';

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

export function generatePairingCode(random: typeof randomBytes = randomBytes): string {
  const bytes = random(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

interface PairingTokenRow {
  token: string;
  code: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
}

interface PairedDeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  created_at: number;
  last_seen_at: number | null;
}

/** In-process fixed-window limiter. The claim endpoint is unauthenticated, so
 * it gets a global attempts budget plus a stricter failures budget — enough to
 * make brute-forcing the 6-char code non-viable on a home server without any
 * per-IP plumbing. */
export function createFixedWindowLimiter(limit: number, windowMs: number, now = Date.now) {
  let windowStart = 0;
  let count = 0;
  return {
    hit(): boolean {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        count = 0;
      }
      count += 1;
      return count <= limit;
    },
    reset(): void {
      windowStart = 0;
      count = 0;
    },
  };
}

export interface DevicesRoutesOptions {
  jwtSecret: string;
  jwtExpiresIn: string;
  auth: MiddlewareHandler;
  remoteAccess: RemoteAccess | null;
  now?: () => number;
}

export function devicesRoutes(options: DevicesRoutesOptions) {
  const { jwtSecret, jwtExpiresIn, auth, remoteAccess } = options;
  const now = options.now ?? Date.now;
  const app = new Hono<AuthEnv>();

  const attemptLimiter = createFixedWindowLimiter(30, 60_000, now);
  const failureLimiter = createFixedWindowLimiter(10, 5 * 60_000, now);

  // POST /api/devices/pair — mint a pairing token + QR payload (auth required).
  app.post('/pair', auth, async (c) => {
    const user = c.get('user');
    const db = getDatabase();
    const token = randomBytes(32).toString('base64url');
    const code = generatePairingCode();
    const createdAt = now();

    // One live pairing token per user: regenerating invalidates the old one.
    db.run('DELETE FROM pairing_tokens WHERE user_id = ? AND claimed_at IS NULL', [user.sub]);
    db.run(
      'INSERT INTO pairing_tokens (token, code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [token, code, user.sub, createdAt, createdAt + PAIRING_TOKEN_TTL_MS],
    );

    const remote = remoteAccess ? await remoteAccess.status() : null;
    const funnelUrl = remoteAccess ? await remoteAccess.publicUrl() : null;
    const urls = candidateUrls({ funnelUrl, requestOrigin: new URL(c.req.url).origin });

    return c.json({
      token,
      code,
      expiresAt: createdAt + PAIRING_TOKEN_TTL_MS,
      name: hostname(),
      urls,
      remoteAccess: remote,
    });
  });

  // POST /api/devices/claim — public. The pairing token IS the credential
  // (same trust model as share/activate): it only exists because a logged-in
  // user minted it moments ago, and claiming exchanges it for that user's
  // normal sliding-session JWT bound to a revocable device row.
  app.post('/claim', async (c) => {
    if (!attemptLimiter.hit()) {
      return c.json({ error: 'Too many attempts, try again later', code: 'RATE_LIMITED' }, 429);
    }

    type ClaimBody = { token?: string; code?: string; deviceName?: string; platform?: string };
    const body = await c.req.json<ClaimBody>().catch(() => ({}) as ClaimBody);
    if (!body.token && !body.code) {
      return c.json({ error: 'token or code is required', code: 'VALIDATION_ERROR' }, 400);
    }

    const db = getDatabase();
    const row = body.token
      ? db
          .query<PairingTokenRow, [string]>('SELECT * FROM pairing_tokens WHERE token = ?')
          .get(body.token)
      : db
          .query<PairingTokenRow, [string]>(
            'SELECT * FROM pairing_tokens WHERE code = ? AND claimed_at IS NULL ORDER BY created_at DESC LIMIT 1',
          )
          .get(body.code!.trim().toUpperCase());

    if (!row) {
      if (!failureLimiter.hit()) {
        return c.json({ error: 'Too many attempts, try again later', code: 'RATE_LIMITED' }, 429);
      }
      return c.json({ error: 'Unknown pairing code', code: 'PAIRING_NOT_FOUND' }, 404);
    }
    const t = now();
    if (row.claimed_at !== null || row.expires_at < t) {
      return c.json({ error: 'Pairing code has expired', code: 'PAIRING_EXPIRED' }, 410);
    }

    const user = db
      .query<{ id: string; username: string; role: string; status: string }, [string]>(
        "SELECT id, username, role, COALESCE(status, 'active') as status FROM users WHERE id = ?",
      )
      .get(row.user_id);
    if (!user || user.status === 'disabled') {
      return c.json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' }, 403);
    }

    db.run('UPDATE pairing_tokens SET claimed_at = ? WHERE token = ?', [t, row.token]);

    const deviceId = randomUUID();
    const platform = body.platform?.trim() || 'unknown';
    const deviceName = body.deviceName?.trim() || defaultDeviceName(platform);
    db.run(
      'INSERT INTO paired_devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      [deviceId, user.id, deviceName, platform, t, t],
    );

    const jwt = await signJwt(
      { sub: user.id, username: user.username, role: asRole(user.role), deviceId },
      jwtSecret,
      jwtExpiresIn,
    );

    return c.json({
      token: jwt,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  // ── TV sign-in via phone approval (issue #389/#392 flow) ──────────────
  // The inverse direction of /pair+/claim: here the UNAUTHENTICATED device
  // (a TV with only a D-pad) mints the code and waits, and the signed-in
  // phone approves it. Three endpoints: request (anonymous, rate-limited,
  // prunes expired rows), approve (auth, audited), claim (anonymous poll;
  // pending until approved; single-use via a compare-and-swap UPDATE).

  const loginRequestLimiter = createFixedWindowLimiter(10, 60_000, now);

  interface LoginRequestRow {
    token: string;
    code: string;
    device_name: string;
    platform: string;
    created_at: number;
    expires_at: number;
    approved_by_user_id: string | null;
    approved_at: number | null;
    claimed_at: number | null;
  }

  // POST /api/devices/login-request — anonymous: mint a code the TV displays.
  app.post('/login-request', async (c) => {
    if (!loginRequestLimiter.hit()) {
      return c.json({ error: 'Too many attempts, try again later', code: 'RATE_LIMITED' }, 429);
    }
    type Body = { deviceName?: string; platform?: string };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const db = getDatabase();
    const t = now();
    // Anonymous minting: prune everything expired so the table can't grow
    // unbounded (pairing_tokens never needs this — its mints are per-user).
    db.run('DELETE FROM login_requests WHERE expires_at < ?', [t]);

    const token = randomBytes(32).toString('base64url');
    const code = generatePairingCode();
    const platform = body.platform?.trim() || 'unknown';
    const deviceName = body.deviceName?.trim() || defaultDeviceName(platform);
    db.run(
      'INSERT INTO login_requests (token, code, device_name, platform, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [token, code, deviceName, platform, t, t + PAIRING_TOKEN_TTL_MS],
    );
    const funnelUrl = remoteAccess ? await remoteAccess.publicUrl() : null;
    const urls = candidateUrls({ funnelUrl, requestOrigin: new URL(c.req.url).origin });
    return c.json({ token, code, expiresAt: t + PAIRING_TOKEN_TTL_MS, urls });
  });

  // POST /api/devices/login-approve — auth: the phone approves a shown code.
  app.post('/login-approve', auth, async (c) => {
    const user = c.get('user');
    type Body = { code?: string };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const code = body.code?.trim().toUpperCase();
    if (!code) return c.json({ error: 'code is required', code: 'VALIDATION_ERROR' }, 400);

    const db = getDatabase();
    const row = db
      .query<LoginRequestRow, [string]>(
        'SELECT * FROM login_requests WHERE code = ? AND claimed_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get(code);
    if (!row) {
      return c.json({ error: 'Unknown sign-in code', code: 'LOGIN_REQUEST_NOT_FOUND' }, 404);
    }
    const t = now();
    if (row.expires_at < t) {
      return c.json({ error: 'Sign-in code has expired', code: 'LOGIN_REQUEST_EXPIRED' }, 410);
    }
    db.run('UPDATE login_requests SET approved_by_user_id = ?, approved_at = ? WHERE token = ?', [
      user.sub,
      t,
      row.token,
    ]);
    recordAudit(db, user, 'devices.approve_login', {
      targetKind: 'device',
      targetId: row.device_name,
      detail: `platform=${row.platform}`,
    });
    return c.json({ ok: true, deviceName: row.device_name });
  });

  // POST /api/devices/login-claim — anonymous: the TV polls its own token.
  app.post('/login-claim', async (c) => {
    if (!attemptLimiter.hit()) {
      return c.json({ error: 'Too many attempts, try again later', code: 'RATE_LIMITED' }, 429);
    }
    type Body = { token?: string };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    if (!body.token) return c.json({ error: 'token is required', code: 'VALIDATION_ERROR' }, 400);

    const db = getDatabase();
    const row = db
      .query<LoginRequestRow, [string]>('SELECT * FROM login_requests WHERE token = ?')
      .get(body.token);
    if (!row) {
      if (!failureLimiter.hit()) {
        return c.json({ error: 'Too many attempts, try again later', code: 'RATE_LIMITED' }, 429);
      }
      return c.json({ error: 'Unknown sign-in request', code: 'LOGIN_REQUEST_NOT_FOUND' }, 404);
    }
    const t = now();
    if (row.claimed_at !== null || row.expires_at < t) {
      return c.json({ error: 'Sign-in request has expired', code: 'LOGIN_REQUEST_EXPIRED' }, 410);
    }
    if (!row.approved_by_user_id) {
      return c.json({ status: 'pending', expiresAt: row.expires_at }, 202);
    }

    const user = db
      .query<{ id: string; username: string; role: string; status: string }, [string]>(
        "SELECT id, username, role, COALESCE(status, 'active') as status FROM users WHERE id = ?",
      )
      .get(row.approved_by_user_id);
    if (!user || user.status === 'disabled') {
      return c.json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' }, 403);
    }

    // Single-use compare-and-swap: two concurrent polls can't both claim.
    const claimed = db.run(
      'UPDATE login_requests SET claimed_at = ? WHERE token = ? AND claimed_at IS NULL',
      [t, row.token],
    );
    if (claimed.changes === 0) {
      return c.json({ error: 'Sign-in request has expired', code: 'LOGIN_REQUEST_EXPIRED' }, 410);
    }

    const deviceId = randomUUID();
    db.run(
      'INSERT INTO paired_devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      [deviceId, user.id, row.device_name, row.platform, t, t],
    );
    const jwt = await signJwt(
      { sub: user.id, username: user.username, role: asRole(user.role), deviceId },
      jwtSecret,
      jwtExpiresIn,
    );
    return c.json({
      token: jwt,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  // GET /api/devices — the caller's paired devices.
  app.get('/', auth, (c) => {
    const user = c.get('user');
    const rows = getDatabase()
      .query<PairedDeviceRow, [string]>(
        'SELECT * FROM paired_devices WHERE user_id = ? ORDER BY created_at DESC',
      )
      .all(user.sub);
    return c.json({
      devices: rows.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        current: row.id === user.deviceId,
      })),
    });
  });

  // DELETE /api/devices/:id — revoke one of the caller's devices. Row absence
  // is the revoked state: the device's JWT dies at its next refresh.
  app.delete('/:id', auth, (c) => {
    const user = c.get('user');
    const result = getDatabase().run('DELETE FROM paired_devices WHERE id = ? AND user_id = ?', [
      c.req.param('id'),
      user.sub,
    ]);
    if (result.changes === 0) return c.json({ error: 'Device not found', code: 'NOT_FOUND' }, 404);
    return c.json({ ok: true });
  });

  return app;
}

function defaultDeviceName(platform: string): string {
  switch (platform) {
    case 'ios':
      return 'iPhone';
    case 'android':
      return 'Android phone';
    case 'electron':
      return 'Desktop';
    default:
      return 'Mobile device';
  }
}
