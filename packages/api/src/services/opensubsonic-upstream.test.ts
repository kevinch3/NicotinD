import { describe, expect, it } from 'bun:test';
import * as jose from 'jose';
import { signJwt } from '../middleware/auth.js';
import { internalUpstream } from './opensubsonic-upstream.js';

const SECRET = 'test-secret-at-least-32-chars-long-xx';

describe('internalUpstream', () => {
  it('calls the app as the user with a verifiable session, reused until it ages out', async () => {
    const seen: Array<{ url: string; auth: string | null; range: string | null }> = [];
    let clock = 0;
    let mints = 0;
    const up = internalUpstream(
      (req) => {
        seen.push({
          url: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          range: req.headers.get('range'),
        });
        return new Response('ok');
      },
      SECRET,
      () => clock,
      (...args) => {
        mints++;
        return signJwt(...args);
      },
    );
    const user = { id: 'u1', username: 'ana', role: 'listener' };

    await up(user, '/api/library/songs/x', { headers: { range: 'bytes=0-1' } });
    await up(user, '/api/library/songs/y');
    expect(seen.map((s) => s.url)).toEqual(['/api/library/songs/x', '/api/library/songs/y']);
    expect(seen[0]?.range).toBe('bytes=0-1');
    expect(mints).toBe(1);

    const token = seen[0]?.auth?.slice('Bearer '.length) ?? '';
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload).toMatchObject({ sub: 'u1', username: 'ana', role: 'listener' });

    // A role change re-mints at once; so does age.
    await up({ ...user, role: 'user' }, '/a');
    const promoted = seen[2]?.auth?.slice('Bearer '.length) ?? '';
    expect((await jose.jwtVerify(promoted, new TextEncoder().encode(SECRET))).payload.role).toBe(
      'user',
    );
    expect(mints).toBe(2);

    clock = 6 * 60_000;
    await up({ ...user, role: 'user' }, '/b');
    expect(mints).toBe(3);
  });
});
