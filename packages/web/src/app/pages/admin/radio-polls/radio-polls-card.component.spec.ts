import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { RadioPollsCardComponent } from './radio-polls-card.component';
import { RadioPollService } from '../../../services/radio-poll.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import type { RadioPollSummary } from '../../../../types/core';

function summary(over: Partial<RadioPollSummary> = {}): RadioPollSummary {
  return {
    id: 'p1',
    token: 'tok1',
    url: 'http://x/poll/tok1',
    name: 'Latin seeds',
    createdAt: 1785848319240,
    expiresAt: null,
    closedAt: null,
    scenarioCount: 3,
    voteCount: 12,
    raterCount: 4,
    ...over,
  };
}

describe('RadioPollsCardComponent', () => {
  const list = vi.fn();
  const create = vi.fn();
  const results = vi.fn();
  const close = vi.fn();
  const remove = vi.fn();
  const show = vi.fn();
  const ask = vi.fn();

  beforeEach(async () => {
    list.mockReset().mockReturnValue(of([summary()]));
    create.mockReset().mockReturnValue(of({ id: 'p2', token: 't2', url: 'http://x/poll/t2' }));
    results.mockReset();
    close.mockReset().mockReturnValue(of({ ok: true }));
    remove.mockReset().mockReturnValue(of({ ok: true }));
    show.mockReset();
    ask.mockReset().mockResolvedValue(true);
    Object.assign(navigator, { clipboard: { writeText: () => Promise.resolve() } });

    await TestBed.configureTestingModule({
      imports: [RadioPollsCardComponent],
      providers: [
        { provide: RadioPollService, useValue: { list, create, results, close, remove } },
        { provide: ToastService, useValue: { show } },
        { provide: ConfirmService, useValue: { ask } },
      ],
    }).compileComponents();
  });

  function createComponent() {
    return TestBed.createComponent(RadioPollsCardComponent).componentInstance;
  }

  it('does not fetch until the group is opened', () => {
    createComponent();
    expect(list).not.toHaveBeenCalled();
  });

  it('loads polls on first open, and not again on re-open', () => {
    const c = createComponent();
    c.load();
    c.load();
    expect(list).toHaveBeenCalledTimes(1);
    expect(c.rows()).toHaveLength(1);
  });

  it('create requires a name and reloads + copies the link on success', () => {
    const c = createComponent();
    c.load();
    c.create();
    expect(create).not.toHaveBeenCalled();

    c.name.set('New poll');
    c.scenarioCount.set(4);
    c.create();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New poll', scenarioCount: 4 }),
    );
    // Link-copied toast + a reload of the list.
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    expect(list).toHaveBeenCalledTimes(2);
    expect(c.name()).toBe('');
  });

  it('surfaces the server reason when create fails', () => {
    create.mockReturnValue(
      throwError(() => ({ error: { error: 'pinned seed song not found or not playable: x' } })),
    );
    const c = createComponent();
    c.name.set('P');
    c.create();
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('pinned seed') }),
    );
    expect(c.creating()).toBe(false);
  });

  it('close marks the row closed in place', () => {
    const c = createComponent();
    c.load();
    c.close(c.rows()[0]);
    expect(close).toHaveBeenCalledWith('p1');
    expect(c.rows()[0].closedAt).not.toBeNull();
    expect(c.status(c.rows()[0])).toBe('closed');
  });

  it('remove asks for confirmation and drops the row', async () => {
    const c = createComponent();
    c.load();
    await c.remove(c.rows()[0]);
    expect(ask).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('p1');
    expect(c.rows()).toHaveLength(0);
  });

  it('remove aborts when the confirm is declined', async () => {
    ask.mockResolvedValue(false);
    const c = createComponent();
    c.load();
    await c.remove(c.rows()[0]);
    expect(remove).not.toHaveBeenCalled();
    expect(c.rows()).toHaveLength(1);
  });

  it('pinned seeds dedupe and remove', () => {
    const c = createComponent();
    const song = { id: 's1', title: 'T', artist: 'A' } as never;
    c.addPinnedSeed(song);
    c.addPinnedSeed(song);
    expect(c.pinnedSeedIds()).toEqual(['s1']);
    c.removePinnedSeed('s1');
    expect(c.pinnedSeedIds()).toEqual([]);
  });
});
