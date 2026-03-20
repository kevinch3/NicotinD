import { Hono } from 'hono';
import { hashPassword, verifyPassword } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { signJwt } from '../middleware/auth.js';

export function authRoutes(jwtSecret: string, jwtExpiresIn: string) {
  const app = new Hono();

  app.post('/register', async (c) => {
    const { username, password } = await c.req.json<{ username: string; password: string }>();

    if (!username || !password) {
      return c.json({ error: 'Username and password are required' }, 400);
    }

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

    db.run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)', [
      id,
      username,
      passwordHash,
      role,
    ]);

    db.run('INSERT INTO user_settings (user_id) VALUES (?)', [id]);

    const token = await signJwt({ sub: id, username, role }, jwtSecret, jwtExpiresIn);

    return c.json({ token, user: { id, username, role } }, 201);
  });

  app.post('/login', async (c) => {
    const { username, password } = await c.req.json<{ username: string; password: string }>();

    const db = getDatabase();
    const user = db
      .query<
        { id: string; username: string; password_hash: string; role: string },
        [string]
      >('SELECT id, username, password_hash, role FROM users WHERE username = ?')
      .get(username);

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = await signJwt(
      { sub: user.id, username: user.username, role: user.role as 'admin' | 'user' },
      jwtSecret,
      jwtExpiresIn,
    );

    return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  return app;
}
