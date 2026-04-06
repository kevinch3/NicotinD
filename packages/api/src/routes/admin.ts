import { Hono } from 'hono';
import { hashPassword } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';

export function adminRoutes() {
  const app = new Hono<AuthEnv>();

  // Admin guard — all routes require admin role
  app.use('*', async (c, next) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // Create a new user (admin-only)
  app.post('/users', async (c) => {
    const { username, password } = await c.req.json<{ username: string; password: string }>();

    if (!username || !password || password.length < 4) {
      return c.json({ error: 'Username and password (min 4 chars) are required' }, 400);
    }

    const db = getDatabase();
    const existing = db
      .query<{ id: string }, [string]>('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (existing) {
      return c.json({ error: 'Username already taken' }, 409);
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    db.query('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      id, username, passwordHash, 'user',
    );
    db.query('INSERT INTO user_settings (user_id) VALUES (?)').run(id);

    return c.json({ id, username, role: 'user', status: 'active', created_at: new Date().toISOString() }, 201);
  });

  // List all users
  app.get('/users', async (c) => {
    const db = getDatabase();
    const users = db
      .query<
        { id: string; username: string; role: string; status: string; created_at: string },
        []
      >("SELECT id, username, role, COALESCE(status, 'active') as status, created_at FROM users ORDER BY created_at ASC")
      .all();
    return c.json(users);
  });

  // Toggle user role
  app.put('/users/:id/role', async (c) => {
    const { id } = c.req.param();
    const { role } = await c.req.json<{ role: 'admin' | 'user' }>();
    const currentUser = c.get('user');

    if (id === currentUser.sub) {
      return c.json({ error: 'Cannot change your own role' }, 400);
    }

    if (role !== 'admin' && role !== 'user') {
      return c.json({ error: 'Role must be "admin" or "user"' }, 400);
    }

    const db = getDatabase();
    const result = db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Enable/disable user
  app.put('/users/:id/status', async (c) => {
    const { id } = c.req.param();
    const { status } = await c.req.json<{ status: 'active' | 'disabled' }>();
    const currentUser = c.get('user');

    if (id === currentUser.sub) {
      return c.json({ error: 'Cannot disable your own account' }, 400);
    }

    if (status !== 'active' && status !== 'disabled') {
      return c.json({ error: 'Status must be "active" or "disabled"' }, 400);
    }

    const db = getDatabase();
    const result = db.run('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Reset user password
  app.put('/users/:id/password', async (c) => {
    const { id } = c.req.param();
    const { password } = await c.req.json<{ password: string }>();

    if (!password || password.length < 4) {
      return c.json({ error: 'Password must be at least 4 characters' }, 400);
    }

    const db = getDatabase();
    const passwordHash = await hashPassword(password);
    const result = db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Delete user
  app.delete('/users/:id', async (c) => {
    const { id } = c.req.param();
    const currentUser = c.get('user');

    if (id === currentUser.sub) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    const db = getDatabase();
    const result = db.run('DELETE FROM users WHERE id = ?', [id]);
    if (result.changes === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
