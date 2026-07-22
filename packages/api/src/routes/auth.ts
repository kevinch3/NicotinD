import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { asRole, hashPassword, verifyPassword } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';

const AuthRequestSchema = z.object({
  username: z.string().min(1).openapi({ example: 'admin' }),
  password: z.string().min(1).openapi({ example: 'password' }),
});

const UserResponseSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: z.string(),
});

const AuthSuccessSchema = z
  .object({
    token: z.string(),
    user: UserResponseSchema,
  })
  .openapi('AuthSuccess');

const RefreshSuccessSchema = z
  .object({
    token: z.string(),
  })
  .openapi('RefreshSuccess');

const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi('Error');

export function authRoutes(jwtSecret: string, jwtExpiresIn: string, registrationEnabled: boolean) {
  const app = new OpenAPIHono<AuthEnv>();

  // Public endpoint: check if registration is open
  app.openapi(
    createRoute({
      method: 'get',
      path: '/registration-status',
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } },
          description: 'Registration status',
        },
      },
    }),
    (c) => c.json({ enabled: registrationEnabled }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/register',
      request: {
        body: {
          content: {
            'application/json': {
              schema: AuthRequestSchema,
            },
          },
        },
      },
      responses: {
        201: {
          content: {
            'application/json': {
              schema: AuthSuccessSchema,
            },
          },
          description: 'User registered successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Bad request',
        },
        403: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Registration disabled',
        },
        409: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Conflict',
        },
      },
    }),
    async (c) => {
      const { username, password } = c.req.valid('json');

      const db = getDatabase();

      // Check if any users exist — first user becomes admin
      const userCount = db
        .query<{ count: number }, []>('SELECT COUNT(*) as count FROM users')
        .get();
      const role = userCount?.count === 0 ? 'admin' : 'user';

      // Block public registration when disabled (first-user setup always allowed)
      if (!registrationEnabled && role !== 'admin') {
        return c.json({ error: 'Registration is disabled' }, 403);
      }

      const existing = db
        .query<{ id: string }, [string]>('SELECT id FROM users WHERE username = ?')
        .get(username);
      if (existing) {
        return c.json({ error: 'Username already taken' }, 409);
      }

      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(password);

      db.query('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
        id,
        username,
        passwordHash,
        role,
      );

      db.query('INSERT INTO user_settings (user_id) VALUES (?)').run(id);

      const token = await signJwt({ sub: id, username, role }, jwtSecret, jwtExpiresIn);

      return c.json({ token, user: { id, username, role } }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login',
      request: {
        body: {
          content: {
            'application/json': {
              schema: AuthRequestSchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: AuthSuccessSchema,
            },
          },
          description: 'Login successful',
        },
        401: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Unauthorized',
        },
        403: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Forbidden',
        },
      },
    }),
    async (c) => {
      const { username, password } = c.req.valid('json');

      const db = getDatabase();
      const user = db
        .query<
          { id: string; username: string; password_hash: string; role: string; status: string },
          [string]
        >("SELECT id, username, password_hash, role, COALESCE(status, 'active') as status FROM users WHERE username = ?")
        .get(username);

      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return c.json({ error: 'Invalid credentials' }, 401);
      }

      if (user.status === 'disabled') {
        return c.json({ error: 'Account disabled' }, 403);
      }

      const token = await signJwt(
        { sub: user.id, username: user.username, role: user.role as 'admin' | 'user' },
        jwtSecret,
        jwtExpiresIn,
      );

      return c.json(
        { token, user: { id: user.id, username: user.username, role: user.role } },
        200,
      );
    },
  );

  // Silent token renewal (sliding session): a currently-valid token is exchanged
  // for a fresh one, so opening the app within the window resets the expiry and
  // you never get bounced to /login. Guarded by authMiddleware, so an expired or
  // missing token 401s and the client falls back to a normal login.
  app.use('/refresh', authMiddleware(jwtSecret));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/refresh',
      responses: {
        200: {
          content: { 'application/json': { schema: RefreshSuccessSchema } },
          description: 'Token renewed',
        },
        401: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Forbidden',
        },
      },
    }),
    async (c) => {
      const user = c.get('user');

      // Share tokens are deliberately short-lived and read-only — never extend them.
      if (user.share === true) {
        return c.json({ error: 'Share sessions cannot be refreshed' }, 403);
      }

      // Re-read the role from the DB (not the old token) so an admin's role change
      // takes effect on the user's next boot instead of waiting for a full
      // re-login. (Missing/disabled accounts are already bounced by authMiddleware
      // before we get here, so a null row only happens in a race — keep the old
      // role in that case rather than dropping them.)
      const db = getDatabase();
      const row = db
        .query<{ role: string }, [string]>('SELECT role FROM users WHERE id = ?')
        .get(user.sub);

      // QR-paired sessions carry a deviceId; a deleted paired_devices row is
      // the revocation signal, enforced here (JWTs are otherwise stateless).
      if (user.deviceId) {
        const device = db
          .query<{ id: string }, [string]>('SELECT id FROM paired_devices WHERE id = ?')
          .get(user.deviceId);
        if (!device) {
          return c.json({ error: 'Device revoked' }, 403);
        }
        db.query('UPDATE paired_devices SET last_seen_at = ? WHERE id = ?').run(
          Date.now(),
          user.deviceId,
        );
      }

      const token = await signJwt(
        {
          sub: user.sub,
          username: user.username,
          role: asRole(row?.role ?? user.role),
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
        jwtSecret,
        jwtExpiresIn,
      );

      return c.json({ token }, 200);
    },
  );

  app.use('/dismiss-welcome', authMiddleware(jwtSecret));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/dismiss-welcome',
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
          description: 'Welcome banner dismissed',
        },
        401: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Unauthorized',
        },
      },
    }),
    async (c) => {
      const user = c.get('user');
      const db = getDatabase();
      db.query('UPDATE user_settings SET welcome_dismissed = 1 WHERE user_id = ?').run(user.sub);
      return c.json({ ok: true }, 200);
    },
  );

  app.use('/autoplay', authMiddleware(jwtSecret));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/autoplay',
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({ enabled: z.boolean() }),
            },
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
          description: 'Autoplay-on-load preference updated',
        },
        401: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Unauthorized',
        },
      },
    }),
    async (c) => {
      const user = c.get('user');
      const body = c.req.valid('json') as { enabled: boolean };
      const db = getDatabase();
      db.query('UPDATE user_settings SET autoplay_on_load = ? WHERE user_id = ?').run(
        body.enabled ? 1 : 0,
        user.sub,
      );
      return c.json({ ok: true }, 200);
    },
  );

  // Admin dev-mode: capture generated results as gradeable feedback (toast).
  // Per-user flag; only meaningful for admins (the capture toast is admin-gated),
  // but stored uniformly. See docs/generation-feedback.md.
  app.use('/feedback-capture', authMiddleware(jwtSecret));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/feedback-capture',
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({ enabled: z.boolean() }),
            },
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
          description: 'Feedback-capture dev-mode preference updated',
        },
        401: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Unauthorized',
        },
      },
    }),
    async (c) => {
      const user = c.get('user');
      const body = c.req.valid('json') as { enabled: boolean };
      const db = getDatabase();
      db.query('UPDATE user_settings SET feedback_capture = ? WHERE user_id = ?').run(
        body.enabled ? 1 : 0,
        user.sub,
      );
      return c.json({ ok: true }, 200);
    },
  );

  app.use('/me', authMiddleware(jwtSecret));
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      responses: {
        200: {
          content: {
            'application/json': {
              schema: UserResponseSchema.extend({
                welcomeDismissed: z.boolean(),
                autoplayOnLoad: z.boolean(),
                feedbackCapture: z.boolean(),
              }).openapi('UserProfile'),
            },
          },
          description: 'Current user profile',
        },
        401: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Unauthorized',
        },
      },
    }),
    async (c) => {
      const user = c.get('user');
      const db = getDatabase();
      const settings = db
        .query<
          { welcome_dismissed: number; autoplay_on_load: number; feedback_capture: number },
          [string]
        >(
          'SELECT COALESCE(welcome_dismissed, 0) as welcome_dismissed, COALESCE(autoplay_on_load, 0) as autoplay_on_load, COALESCE(feedback_capture, 0) as feedback_capture FROM user_settings WHERE user_id = ?',
        )
        .get(user.sub);
      return c.json({
        id: user.sub,
        username: user.username ?? '',
        role: user.role ?? 'user',
        welcomeDismissed: (settings?.welcome_dismissed ?? 0) === 1,
        autoplayOnLoad: (settings?.autoplay_on_load ?? 0) === 1,
        feedbackCapture: (settings?.feedback_capture ?? 0) === 1,
      } as {
        id: string;
        username: string;
        role: string;
        welcomeDismissed: boolean;
        autoplayOnLoad: boolean;
        feedbackCapture: boolean;
      }, 200);
    },
  );

  return app;
}
