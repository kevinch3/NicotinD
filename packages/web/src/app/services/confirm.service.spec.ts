import { TestBed } from '@angular/core/testing';
import { ConfirmService } from './confirm.service';

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

  it('ask() resolves false on cancel', async () => {
    const p = svc.ask('Delete this?');
    svc.resolve(false);
    await expect(p).resolves.toBe(false);
    expect(svc.request()).toBeNull();
  });
});
