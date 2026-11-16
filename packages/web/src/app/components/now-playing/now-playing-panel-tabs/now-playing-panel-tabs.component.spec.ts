import { TestBed } from '@angular/core/testing';
import { NowPlayingPanelTabsComponent } from './now-playing-panel-tabs.component';
import { setInputValue } from '../../../../testing/signal-input';
import { vi } from 'vitest';
import { haptic } from '../../../lib/haptics';

vi.mock('../../../lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/haptics')>()),
  haptic: vi.fn(),
}));

// The strip's markup is `IconTabsComponent`'s (#1668), pinned in its own spec.
// Here: what the registry hands it, and what a press does.
describe('NowPlayingPanelTabsComponent', () => {
  function make(opts: { queueCount?: number; hasLyrics?: boolean; activePanel?: string } = {}) {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    const c = fixture.componentInstance;
    if (opts.queueCount !== undefined) setInputValue(c.queueCount, opts.queueCount);
    if (opts.hasLyrics !== undefined) setInputValue(c.hasLyrics, opts.hasLyrics);
    if (opts.activePanel !== undefined) setInputValue(c.activePanel, opts.activePanel);
    fixture.detectChanges();
    const item = (id: string) => c.items().find((i) => i.value === id)!;
    return { fixture, c, item };
  }

  it('hands the bar one item per registered tab, under the testids e2e uses', () => {
    const { c } = make();
    expect(c.items().map((i) => [i.value, i.testid, i.icon, i.label])).toEqual([
      ['queue', 'now-playing-tab-queue', 'queue', 'nowPlaying.nextUp'],
      ['lyrics', 'now-playing-tab-lyrics', 'mic', 'nowPlaying.lyrics'],
    ]);
  });

  it('shows the queue count on the queue tab, and nothing for an empty queue', () => {
    expect(make({ queueCount: 4 }).item('queue')).toMatchObject({
      badge: 4,
      badgeTestid: 'now-playing-queue-count',
    });
    expect(make({ queueCount: 0 }).item('queue').badge).toBeNull();
  });

  it('shows a lyrics-availability dot when hasLyrics is true', () => {
    expect(make({ hasLyrics: true }).item('lyrics')).toMatchObject({
      badge: '',
      badgeTestid: 'now-playing-lyrics-dot',
    });
  });

  it('hides the dot when hasLyrics is false', () => {
    expect(make({ hasLyrics: false }).item('lyrics').badge).toBeNull();
  });

  it('hides the dot once the lyrics tab is already active', () => {
    expect(make({ hasLyrics: true, activePanel: 'lyrics' }).item('lyrics').badge).toBeNull();
  });

  it('renders the shared tab bar as a tablist', () => {
    const { fixture } = make();
    const bar = (fixture.nativeElement as HTMLElement).querySelector('app-icon-tabs');
    expect(bar?.getAttribute('variant')).toBe('tabs');
  });

  it('emits panelSelected for the pressed tab, the shown one included', () => {
    const { c } = make({ activePanel: 'queue' });
    const seen: string[] = [];
    c.panelSelected.subscribe((p: string) => seen.push(p));
    c.select('lyrics');
    c.select('queue');
    expect(seen).toEqual(['lyrics', 'queue']);
  });

  it('a tab switch ticks `select`; pressing the shown tab does not (#1659)', () => {
    vi.mocked(haptic).mockClear();
    const { c } = make({ activePanel: 'queue' });
    c.select('queue');
    expect(haptic).not.toHaveBeenCalled();
    c.select('lyrics');
    expect(haptic).toHaveBeenCalledExactlyOnceWith('select');
  });
});
