import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { hashPassword, verifyPassword } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { signJwt } from '../middleware/auth.js';

const AuthRequestSchema = z.object({
  username: z.string().min(1).openapi({ example: 'admin' }),
  password: z.string().min(1).openapi({ example: 'password' }),
});

const UserResponseSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: z.string(),
});

const AuthSuccessSchema = z.object({
  token: z.string(),
  user: UserResponseSchema,
}).openapi('AuthSuccess');

const ErrorSchema = z.object({
  error: z.string(),
}).openapi('Error');

export function authRoutes(jwtSecret: string, jwtExpiresIn: string) {
  const app = new OpenAPIHono();

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
      const userCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM users').get();
      const role = userCount?.count === 0 ? 'admin' : 'user';

      const existing = db
        .query<{ id: string }, [string]>('SELECT id FROM users WHERE username = ?')
        .get(username);
      if (existing) {
        return c.json({ error: 'Username already taken' }, 409);
      }

      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(password);

      db.query('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(id, username, passwordHash, role);

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

      return c.json({ token, user: { id: user.id, username: user.username, role: user.role } }, 200);
    },
  );

  return app;
}
