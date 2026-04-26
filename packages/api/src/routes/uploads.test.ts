import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { uploadRoutes } from './uploads.js';

describe('uploads routes', () => {
  let slskdMock: any;
  let app: Hono<any>;

  beforeEach(() => {
    slskdMock = {
      transfers: {
        getUploads: mock(() =>
          Promise.resolve([
            {
              username: 'peer1',
              directories: [
                {
                  directory: 'Music\\Album',
                  fileCount: 2,
                  files: [
                    { id: 'u1', filename: 'Music\\Album\\01.mp3', state: 'InProgress', bytesTransferred: 500, percentComplete: 50 },
                    { id: 'u2', filename: 'Music\\Album\\02.mp3', state: 'Queued, Remotely', bytesTransferred: 0, percentComplete: 0 },
                  ],
                },
              ],
            },
          ]),
        ),
      },
    };

    app = new Hono();
    app.route('/', uploadRoutes({ current: slskdMock }));
  });

  it('GET / returns upload groups from slskd', async () => {
    const res = await app.request('/');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].username).toBe('peer1');
    expect(data[0].directories[0].files).toHaveLength(2);
  });

  it('GET / returns 503 when slskdRef is null', async () => {
    app = new Hono();
    app.route('/', uploadRoutes({ current: null }));

    const res = await app.request('/');
    expect(res.status).toBe(503);
  });

  it('GET / returns empty array when peer has no uploads', async () => {
    slskdMock.transfers.getUploads = mock(() => Promise.resolve([]));

    const res = await app.request('/');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual([]);
  });
});
