import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { downloadRoutes } from './downloads.js';
import { ProviderRegistry } from '../services/provider-registry.js';
import { SlskdSearchProvider } from '../services/providers/slskd-provider.js';
// Mock getDatabase to use an in-memory DB
const testDb = new Database(':memory:');
testDb.run(`
  CREATE TABLE IF NOT EXISTS hidden_transfers (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
}));

describe('downloads routes', () => {
  let slskdMock: any;
  let app: Hono<any>;

  beforeEach(() => {
    testDb.run('DELETE FROM hidden_transfers');
    
    slskdMock = {
      transfers: {
        getDownloads: mock(() => Promise.resolve([
          {
            username: 'user1',
            directories: [
              {
                directory: 'dir1',
                files: [
                  { id: 'guid1', filename: 'file1.mp3', state: 'Completed, Succeeded' },
                  { id: 'guid2', filename: 'file2.mp3', state: 'InProgress' }
                ]
              }
            ]
          }
        ])),
        cancel: mock(() => Promise.resolve()),
        cancelAll: mock(() => Promise.resolve()),
      }
    };

    const slskdRef = { current: slskdMock };
    app = new Hono();
    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));
    app.route('/', downloadRoutes(registry, slskdRef));
  });

  it('GET / returns all downloads when none are hidden', async () => {
    const res = await app.request('/');
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data[0].directories[0].files).toHaveLength(2);
  });

  it('GET / filters out hidden transfers', async () => {
    testDb.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['guid1']);
    
    const res = await app.request('/');
    const data: any = await res.json();
    
    expect(data[0].directories[0].files).toHaveLength(1);
    expect(data[0].directories[0].files[0].id).toBe('guid2');
  });

  it('DELETE /:username/:id adds to hidden_transfers and calls slskd cancel', async () => {
    const res = await app.request('/user1/guid1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    
    const hidden = testDb.query('SELECT * FROM hidden_transfers WHERE id = ?').get('guid1');
    expect(hidden).toBeDefined();
    expect(slskdMock.transfers.cancel).toHaveBeenCalledWith('user1', 'guid1');
  });

  it('DELETE / clears all hidden transfers and calls slskd cancelAll', async () => {
    testDb.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['guid1']);
    
    const res = await app.request('/', { method: 'DELETE' });
    expect(res.status).toBe(200);
    
    const hiddenCount = testDb.query('SELECT COUNT(*) as count FROM hidden_transfers').get() as { count: number };
    expect(hiddenCount.count).toBe(0);
    expect(slskdMock.transfers.cancelAll).toHaveBeenCalled();
  });
});
