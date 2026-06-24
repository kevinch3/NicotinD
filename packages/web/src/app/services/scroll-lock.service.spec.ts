import { ScrollLockService } from './scroll-lock.service';

describe('ScrollLockService', () => {
  let svc: ScrollLockService;
  const root = () => document.documentElement;

  beforeEach(() => {
    root().style.overflow = '';
    root().style.overscrollBehavior = '';
    svc = new ScrollLockService();
  });

  it('pins the document on first lock and restores on last unlock', () => {
    expect(svc.locked).toBe(false);

    svc.lock();
    expect(svc.locked).toBe(true);
    expect(root().style.overflow).toBe('hidden');
    expect(root().style.overscrollBehavior).toBe('none');

    svc.unlock();
    expect(svc.locked).toBe(false);
    expect(root().style.overflow).toBe('');
    expect(root().style.overscrollBehavior).toBe('');
  });

  it('ref-counts nested locks — stays locked until the last release', () => {
    svc.lock();
    svc.lock();
    expect(svc.locked).toBe(true);

    svc.unlock();
    // one holder remains
    expect(svc.locked).toBe(true);
    expect(root().style.overflow).toBe('hidden');

    svc.unlock();
    expect(svc.locked).toBe(false);
    expect(root().style.overflow).toBe('');
  });

  it('restores the prior inline overflow rather than blanking it', () => {
    root().style.overflow = 'auto';
    svc.lock();
    expect(root().style.overflow).toBe('hidden');
    svc.unlock();
    expect(root().style.overflow).toBe('auto');
  });

  it('extra unlock calls are a no-op (never goes negative)', () => {
    svc.unlock();
    expect(svc.locked).toBe(false);
    svc.lock();
    expect(svc.locked).toBe(true);
    expect(root().style.overflow).toBe('hidden');
  });
});
