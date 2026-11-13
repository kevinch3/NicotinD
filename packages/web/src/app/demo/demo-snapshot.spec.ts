import { describe, expect, it } from 'vitest';
import {
  DEMO_UNSUPPORTED,
  DemoServer,
  nearestRecorded,
  phaseId,
  requestKey,
  type DemoSnapshot,
} from './demo-snapshot';

const A = 'Kai Engel\u0000The Run';

function snapshot(): DemoSnapshot {
  return {
    version: 1,
    phases: {
      '': {
        'GET /api/library/albums': { status: 200, body: ['base'] },
        'GET /api/library/albums/a1': { status: 200, body: { id: 'a1' } },
        'GET /api/catalog/search?q=kai+engel': { status: 200, body: ['kai'] },
        'GET /api/catalog/search?q=zzqx': { status: 200, body: [] },
        'GET /api/downloads/jobs': { status: 200, body: [] },
      },
      [phaseId([A])]: {
        'GET /api/library/albums': { status: 200, body: ['base', 'the run'] },
        'GET /api/downloads/jobs': { status: 200, body: [{ stage: 'done' }] },
      },
    },
    gets: [
      {
        album: A,
        title: 'The Run',
        trigger: {
          method: 'POST',
          path: '/api/discography/albums/7/hunt',
          status: 202,
          body: { ok: true },
        },
        durationMs: 1000,
        timeline: [
          { t: 0, key: 'GET /api/downloads/jobs', status: 200, body: [{ stage: 'queued' }] },
          { t: 500, key: 'GET /api/downloads/jobs', status: 200, body: [{ stage: 'downloading' }] },
        ],
      },
    ],
  };
}

describe('requestKey', () => {
  it('drops volatile params and sorts the rest', () => {
    expect(requestKey('get', '/api/x?token=abc&b=2&a=1&ngsw-bypass=1')).toBe('GET /api/x?a=1&b=2');
    expect(requestKey('GET', 'http://host/api/x?token=t')).toBe('GET /api/x');
  });
});

describe('nearestRecorded', () => {
  const entries = snapshot().phases['']!;
  it('picks the recorded search sharing the most words', () => {
    expect(nearestRecorded(entries, 'GET /api/catalog/search?q=engel')?.body).toEqual(['kai']);
  });
  it('falls back to the no-match recording when nothing overlaps', () => {
    expect(nearestRecorded(entries, 'GET /api/catalog/search?q=beatles')?.body).toEqual([]);
  });
  it('answers an unseen query on a non-search path with its first recording', () => {
    expect(nearestRecorded(entries, 'GET /api/library/albums?sort=new')?.body).toEqual(['base']);
  });
});

describe('DemoServer', () => {
  it('serves the base phase', () => {
    const demo = new DemoServer(snapshot(), () => 0);
    expect(demo.handle('GET', '/api/library/albums?token=x', null).body).toEqual(['base']);
  });

  it('replays a Get on its clock, then lands the album', () => {
    let now = 0;
    const demo = new DemoServer(snapshot(), () => now);
    expect(demo.handle('POST', '/api/discography/albums/7/hunt', {}).status).toBe(202);
    expect(demo.handle('GET', '/api/downloads/jobs', null).body).toEqual([{ stage: 'queued' }]);
    now = 600;
    expect(demo.handle('GET', '/api/downloads/jobs', null).body).toEqual([
      { stage: 'downloading' },
    ]);
    // Not in the timeline: the phase the Get started from still answers.
    expect(demo.handle('GET', '/api/library/albums', null).body).toEqual(['base']);
    now = 1000;
    expect(demo.handle('GET', '/api/library/albums', null).body).toEqual(['base', 'the run']);
    expect(demo.acquiredAlbums()).toEqual([A]);
  });

  it('restores acquired albums across a reload', () => {
    const demo = new DemoServer(snapshot(), () => 0, { acquired: [A] });
    expect(demo.handle('GET', '/api/downloads/jobs', null).body).toEqual([{ stage: 'done' }]);
    // An acquired album's trigger does not start its Get again.
    expect(demo.handle('POST', '/api/discography/albums/7/hunt', {}).status).toBe(200);
  });

  it('resumes a Get in flight after a reload', () => {
    let now = 0;
    const first = new DemoServer(snapshot(), () => now);
    first.handle('POST', '/api/discography/albums/7/hunt', {});
    now = 600;
    const reloaded = new DemoServer(snapshot(), () => now, first.state());
    expect(reloaded.handle('GET', '/api/downloads/jobs', null).body).toEqual([
      { stage: 'downloading' },
    ]);
    now = 1000;
    expect(reloaded.acquiredAlbums()).toEqual([A]);
  });

  it('refuses deletes and admin writes, and no-ops the rest', () => {
    const demo = new DemoServer(snapshot(), () => 0);
    expect(demo.handle('DELETE', '/api/library/albums/a1', null)).toBe(DEMO_UNSUPPORTED);
    expect(demo.handle('PUT', '/api/admin/settings', {})).toBe(DEMO_UNSUPPORTED);
    expect(demo.handle('POST', '/api/history/scrobble', {})).toEqual({ status: 200, body: {} });
  });

  it('404s a GET no phase recorded', () => {
    const demo = new DemoServer(snapshot(), () => 0);
    expect(demo.handle('GET', '/api/never/seen', null).status).toBe(404);
  });
});
