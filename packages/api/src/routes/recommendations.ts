import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import {
  FEEDBACK_KINDS,
  excludedSongs,
  recordFeedback,
  type FeedbackKind,
} from '../services/recommendation/feedback-store.js';

/**
 * Per-listener recommendation feedback. Every endpoint is scoped to the caller
 * (`user.sub`) and takes no user id — a rejection is one person's, like
 * listening history, and there being nothing to pass is what makes that
 * structural. See docs/radio.md "Per-user exclusions".
 */
export function recommendationRoutes() {
  const app = new Hono<AuthEnv>();

  // POST /feedback — one vote: an explicit exclude/restore, or a variety vote
  // from the radio chip. `context` is free-form and stored verbatim for the
  // recommender to learn from later; it is never interpreted here.
  app.post('/feedback', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as {
      songId?: unknown;
      kind?: unknown;
      context?: unknown;
    };
    if (typeof body.songId !== 'string' || !body.songId) {
      return c.json({ error: 'songId is required', code: 'VALIDATION_ERROR' }, 400);
    }
    if (!(FEEDBACK_KINDS as readonly string[]).includes(String(body.kind))) {
      return c.json(
        { error: `kind must be one of ${FEEDBACK_KINDS.join(', ')}`, code: 'VALIDATION_ERROR' },
        400,
      );
    }
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? (body.context as Record<string, unknown>)
        : undefined;
    const db = getDatabase();
    const exists = db
      .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE id = ?')
      .get(body.songId);
    if (!exists) return c.json({ error: 'Song not found', code: 'NOT_FOUND' }, 404);
    const { id } = recordFeedback(db, {
      userId: user.sub,
      songId: body.songId,
      kind: body.kind as FeedbackKind,
      context,
    });
    return c.json({ id }, 201);
  });

  // GET /excluded — everything the feeds currently hold out for the caller,
  // explicit and derived, newest first, with the song's identity attached so
  // the settings list can render without a second round-trip.
  app.get('/excluded', (c) => {
    const user = c.get('user');
    const db = getDatabase();
    const rows = excludedSongs(db, user.sub);
    const songs = rows.map((r) => {
      const song = db
        .query<
          {
            id: string;
            title: string;
            artist: string;
            artist_id: string;
            album_id: string;
            album: string | null;
            cover_art: string | null;
            duration: number;
          },
          [string]
        >(
          `SELECT s.id, s.title, s.artist, s.artist_id, s.album_id, a.name AS album, s.cover_art, s.duration
           FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id WHERE s.id = ?`,
        )
        .get(r.songId);
      return {
        ...r,
        song: song
          ? {
              id: song.id,
              title: song.title,
              artist: song.artist,
              artistId: song.artist_id,
              albumId: song.album_id,
              album: song.album ?? undefined,
              coverArt: song.cover_art ?? undefined,
              duration: song.duration,
            }
          : null,
      };
    });
    return c.json({ excluded: songs });
  });

  // DELETE /excluded/:songId — "recommend again". Writes a restore rather than
  // deleting rows, so a derived (skip-based) exclusion is overridden the same
  // way an explicit one is, and the history of the decision survives.
  app.delete('/excluded/:songId', (c) => {
    const user = c.get('user');
    const songId = c.req.param('songId');
    const db = getDatabase();
    recordFeedback(db, { userId: user.sub, songId, kind: 'restore' });
    return c.json({ ok: true });
  });

  return app;
}
