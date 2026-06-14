import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  recordAcquisition,
  recordAcquisitionIfMissing,
  getAcquisitionByPath,
} from './acquisition-store.js';

describe('acquisition-store', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('records and reads back acquisition provenance by path', () => {
    recordAcquisition(db, {
      relativePath: 'Artist/Album/01.flac',
      method: 'slskd',
      sourceRef: 'peer1',
      startedAt: 1000,
      completedAt: 2000,
    });
    expect(getAcquisitionByPath(db, 'Artist/Album/01.flac')).toEqual({
      method: 'slskd',
      sourceRef: 'peer1',
      acquiredAt: 2000,
      storagePath: 'Artist/Album/01.flac',
    });
  });

  it('returns null for an unrecorded path', () => {
    expect(getAcquisitionByPath(db, 'nope.mp3')).toBeNull();
  });

  it('recordAcquisition upserts (last write wins)', () => {
    recordAcquisition(db, { relativePath: 'a.mp3', method: 'unknown', startedAt: 1 });
    recordAcquisition(db, {
      relativePath: 'a.mp3',
      method: 'ytdlp',
      sourceRef: 'https://x',
      startedAt: 5,
      completedAt: 9,
    });
    expect(getAcquisitionByPath(db, 'a.mp3')?.method).toBe('ytdlp');
  });

  it('recordAcquisitionIfMissing does not overwrite an existing row', () => {
    recordAcquisition(db, { relativePath: 'a.mp3', method: 'slskd', startedAt: 1 });
    recordAcquisitionIfMissing(db, { relativePath: 'a.mp3', method: 'unknown', startedAt: 2 });
    expect(getAcquisitionByPath(db, 'a.mp3')?.method).toBe('slskd');
  });

  it('coerces an unrecognized method to "unknown" on read', () => {
    db.run(
      `INSERT INTO acquisitions (relative_path, method, stage, started_at) VALUES (?, 'bogus', 'done', 1)`,
      ['a.mp3'],
    );
    expect(getAcquisitionByPath(db, 'a.mp3')?.method).toBe('unknown');
  });
});
