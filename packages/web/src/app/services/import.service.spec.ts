import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ImportService } from './import.service';

describe('ImportService', () => {
  const get = vi.fn();
  const post = vi.fn();
  const del = vi.fn();
  let svc: ImportService;

  beforeEach(() => {
    get.mockReset().mockReturnValue(of({}));
    post.mockReset().mockReturnValue(of({}));
    del.mockReset().mockReturnValue(of({}));
    TestBed.configureTestingModule({
      providers: [ImportService, { provide: HttpClient, useValue: { get, post, delete: del } }],
    });
    svc = TestBed.inject(ImportService);
  });

  it('hits the admin import endpoints with the expected payloads', () => {
    svc.preview('/mnt/x').subscribe();
    expect(post).toHaveBeenCalledWith('/api/admin/import/preview', { path: '/mnt/x' });

    svc.submit('/mnt/x', true).subscribe();
    expect(post).toHaveBeenCalledWith('/api/admin/import', {
      path: '/mnt/x',
      removeOriginals: true,
    });

    svc.jobs().subscribe();
    expect(get).toHaveBeenCalledWith('/api/admin/import/jobs');

    svc.cancel('j1').subscribe();
    expect(post).toHaveBeenCalledWith('/api/admin/import/jobs/j1/cancel', {});

    svc.retry('j1').subscribe();
    expect(post).toHaveBeenCalledWith('/api/admin/import/jobs/j1/retry', {});

    svc.delete('j1').subscribe();
    expect(del).toHaveBeenCalledWith('/api/admin/import/jobs/j1');
  });
});
