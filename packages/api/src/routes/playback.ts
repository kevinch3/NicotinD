import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { playbackRegistry } from '../services/playback-registry.js';

/**
 * The caller's remote-playback session over HTTP. The session itself lives on
 * `GET /api/ws/playback` (services/websocket.ts); this is the one operation
 * that must work *without* a healthy socket — ending a session whose output
 * is stuck or gone (docs/remote-playback.md "When a session ends"). Scoped to
 * the caller (`user.sub`), like the socket: there is no user id to pass.
 */
export function playbackRoutes() {
  const app = new Hono<AuthEnv>();

  // GET /session — the state the socket would sync to a fresh tab, readable
  // without opening one: "is my session stuck?" for an operator, and the only
  // non-vacuous way a test can assert that it started clean.
  app.get('/session', (c) => c.json(playbackRegistry.getOrCreate(c.get('user').sub).getState()));

  // POST /session/reset — end the session now and forget every device whose
  // socket is already gone. Live devices stay registered and learn the new
  // (empty) state through their socket.
  app.post('/session/reset', (c) => {
    playbackRegistry.getOrCreate(c.get('user').sub).reset();
    return c.body(null, 204);
  });

  return app;
}
