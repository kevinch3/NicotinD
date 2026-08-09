/**
 * The hunt/base → `feedbackId` contract. Issue #451: this field is the only thing
 * that lets the client offer a grading prompt, yet nothing asserted the server
 * emits it — the web side declares it by hand in api-types.ts with no server
 * counterpart. See docs/generation-feedback.md.
 */
import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import { listFeedback } from '../services/generation-feedback.js';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';

const lidarr = () =>
  ({
    album: {
      get: mock(async () => ({
        id: 1,
        title: 'Porfiado',
        foreignAlbumId: 'rg-1',
        artist: { artistName: 'El Cuarteto de Nos', foreignArtistId: 'ar-1' },
      })),
    },
    track: {
      listByAlbum: mock(async () => [
        { trackNumber: '1', title: 'Yendo a la Casa de Damián' },
        { trackNumber: '2', title: 'Buen Día' },
      ]),
    },
  }) as unknown as Lidarr;

const hunter = () =>
  ({
    huntBase: mock(async () => ({
      candidates: [
        {
          username: 'alice',
          directory: 'A/Porfiado',
          matchPct: 100,
          matchedTracks: 2,
          totalTracks: 2,
          format: 'FLAC',
          files: [{ filename: 'A/Porfiado/01.flac', size: 1 }],
        },
      ],
      skewNeeded: false,
      responses: [{ username: 'alice', files: [{ filename: 'A/Porfiado/01.flac', size: 1 }] }],
    })),
  }) as unknown as AlbumHunterService;

function makeApp(role: 'admin' | 'user', captureEnabled: boolean) {
  const db = new Database(':memory:');
  applySchema(db);
  db.run(`INSERT INTO user_settings (user_id, feedback_capture) VALUES (?, ?)`, [
    'u1',
    captureEnabled ? 1 : 0,
  ]);

  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u1', username: 'boss', role, iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    discographyRoutes({
      discography: {} as DiscographyService,
      hunter: hunter(),
      sourceHunt: {} as AlbumHuntOrchestrator,
      lidarr: lidarr(),
      db,
      slskdRef: { current: null } as SlskdRef,
      version: '9.9.9',
    }),
  );
  return { app, db };
}

const hunt = (app: Hono<AuthEnv>) =>
  app.request('/albums/1/hunt/base', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

describe('POST /albums/:id/hunt/base — feedback capture', () => {
  it('emits a feedbackId and snapshots the proposal for a gated-in admin', async () => {
    const { app, db } = makeApp('admin', true);
    const body = (await (await hunt(app)).json()) as { feedbackId?: number };

    expect(body.feedbackId).toBeGreaterThan(0);

    const [row] = listFeedback(db, {});
    expect(row.id).toBe(body.feedbackId!);
    expect(row.verdict).toBeNull();
    expect(row.engineVersion).toBe('9.9.9');
    const input = row.input as { artistName: string; releaseGroupMbid?: string };
    expect(input.artistName).toBe('El Cuarteto de Nos');
    expect(input.releaseGroupMbid).toBe('rg-1');
    // The RAW responses are what makes an offline replay faithful.
    const output = row.output as { rawResponses: unknown[]; candidates: unknown[] };
    expect(output.rawResponses).toHaveLength(1);
    expect(output.candidates).toHaveLength(1);
  });

  it('omits feedbackId (and records nothing) when the dev toggle is off', async () => {
    const { app, db } = makeApp('admin', false);
    const body = (await (await hunt(app)).json()) as { feedbackId?: number };

    expect(body.feedbackId).toBeUndefined();
    expect(listFeedback(db, {})).toHaveLength(0);
  });

  it('omits feedbackId for a non-admin even with the toggle on', async () => {
    const { app, db } = makeApp('user', true);
    const body = (await (await hunt(app)).json()) as { feedbackId?: number };

    expect(body.feedbackId).toBeUndefined();
    expect(listFeedback(db, {})).toHaveLength(0);
  });
});
