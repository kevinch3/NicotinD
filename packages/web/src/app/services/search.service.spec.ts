import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchService } from './search.service';
import type { CatalogSearchResult } from './api/api-types';

const CATALOG = { artists: [], albums: [] } as CatalogSearchResult;

describe('SearchService resets (#1563)', () => {
  let svc: SearchService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(SearchService);
    svc.addToHistory('damian lazarus');
    svc.addDownloadedFolder('peer::Music\\Album');
    svc.addDownloading('peer:Music\\Album\\01.flac');
    svc.network.set([{ username: 'peer' } as never]);
    svc.catalog.set(CATALOG);
  });

  it('a new search clears its results and keeps what the user did', () => {
    svc.resetResults();
    expect(svc.network()).toEqual([]);
    expect(svc.catalog()).toBeNull();
    expect(svc.history()).toEqual(['damian lazarus']);
    expect(svc.downloadedFolders().has('peer::Music\\Album')).toBe(true);
    expect(localStorage.getItem('nicotind:downloaded-folders')).toContain('Music');
    expect(svc.downloading().size).toBe(1);
  });

  it('logout clears everything, storage included', () => {
    svc.reset();
    expect(svc.catalog()).toBeNull();
    expect(svc.history()).toEqual([]);
    expect(svc.downloadedFolders().size).toBe(0);
    expect(localStorage.getItem('nicotind:downloaded-folders')).toBeNull();
    expect(svc.downloading().size).toBe(0);
  });
});
