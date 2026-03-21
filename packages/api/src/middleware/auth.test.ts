import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { authMiddleware, signJwt } from './auth.js';

describe('authMiddleware', () => {
  const SECRET = 'test-secret';
  let app: Hono<any>;

  beforeEach(() => {
    app = new Hono();
    app.use('/protected', authMiddleware(SECRET));
    app.get('/protected', (c) => c.json({ ok: true, user: c.get('user') }));
  });

  it('returns 401 if no token is provided', async () => {
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('returns 401 for an invalid token', async () => {
    const res = await app.request('/protected', {
      headers: { 'Authorization': 'Bearer invalid-token' }
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' });
  });

  it('returns 200 for a valid token in the Authorization header', async () => {
    const payload = { id: 'user-123', username: 'testuser', role: 'user' as const };
    const token = await signJwt(payload, SECRET);
    
    const res = await app.request('/protected', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.ok).toBe(true);
    expect(data.user.username).toBe('testuser');
  });

  it('returns 200 for a valid token in the query parameter', async () => {
    const payload = { id: 'user-456', username: 'queryuser', role: 'admin' as const };
    const token = await signJwt(payload, SECRET);
    
    const res = await app.request(`/protected?token=${token}`);
    
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.user.username).toBe('queryuser');
  });

  it('returns 401 if token is signed with a different secret', async () => {
    const payload = { id: 'user-123', username: 'testuser', role: 'user' as const };
    const token = await signJwt(payload, 'wrong-secret');
    
    const res = await app.request('/protected', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    expect(res.status).toBe(401);
  });
});
