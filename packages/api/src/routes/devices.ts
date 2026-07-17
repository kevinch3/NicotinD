import { Hono } from 'hono';
import { hostname } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { asRole } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { candidateUrls } from '../services/pairing-urls.js';
import type { RemoteAccess } from '../services/tailscale.js';

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Human-typable fallback code: 6 chars over a 32-symbol alphabet with the
 * ambiguous 0/O/1/I removed — ~1.07e9 combinations against a 5-minute TTL
 * and the claim rate limiter below. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

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
      return c.json({ error: 'Too many attempts, try again later' }, 429);
    }

    type ClaimBody = { token?: string; code?: string; deviceName?: string; platform?: string };
    const body = await c.req.json<ClaimBody>().catch(() => ({}) as ClaimBody);
    if (!body.token && !body.code) {
      return c.json({ error: 'token or code is required' }, 400);
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
        return c.json({ error: 'Too many attempts, try again later' }, 429);
      }
      return c.json({ error: 'Unknown pairing code' }, 404);
    }
    const t = now();
    if (row.claimed_at !== null || row.expires_at < t) {
      return c.json({ error: 'Pairing code has expired' }, 410);
    }

    const user = db
      .query<
        { id: string; username: string; role: string; status: string },
        [string]
      >("SELECT id, username, role, COALESCE(status, 'active') as status FROM users WHERE id = ?")
      .get(row.user_id);
    if (!user || user.status === 'disabled') {
      return c.json({ error: 'Account disabled' }, 403);
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
    if (result.changes === 0) return c.json({ error: 'Device not found' }, 404);
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
