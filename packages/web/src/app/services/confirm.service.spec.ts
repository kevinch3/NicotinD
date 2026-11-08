import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ConfirmService } from './confirm.service';
import { haptic } from '../lib/haptics';

vi.mock('../lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/haptics')>()),
  haptic: vi.fn(),
}));

describe('ConfirmService', () => {
  let svc: ConfirmService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ConfirmService] });
    svc = TestBed.inject(ConfirmService);
  });

  it('ask() opens a request and resolves true on confirm', async () => {
    const p = svc.ask('Delete this?');
    expect(svc.request()?.message).toBe('Delete this?');
    svc.resolve(true);
    await expect(p).resolves.toBe(true);
    expect(svc.request()).toBeNull();
  });

  it('ask() ticks `warning` once, when the dialog opens (#1659)', () => {
    vi.mocked(haptic).mockClear();
    void svc.ask('Delete this?');
    expect(haptic).toHaveBeenCalledExactlyOnceWith('warning');
    svc.resolve(false);
    expect(haptic).toHaveBeenCalledTimes(1);
  });

  it('a non-destructive ask() opens silently, and keeps `destructive` off the request (#1659)', () => {
    vi.mocked(haptic).mockClear();
    void svc.ask('Download 5 files?', { confirmLabel: 'Download', destructive: false });
    expect(haptic).not.toHaveBeenCalled();
    expect(svc.request()).toEqual({ message: 'Download 5 files?', confirmLabel: 'Download' });
    svc.resolve(false);
  });

  it('ask() resolves false on cancel', async () => {
    const p = svc.ask('Delete this?');
    svc.resolve(false);
    await expect(p).resolves.toBe(false);
    expect(svc.request()).toBeNull();
  });
});
