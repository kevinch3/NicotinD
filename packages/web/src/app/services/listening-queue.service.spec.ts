import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ListeningQueueService, type PlayEventPayload } from './listening-queue.service';
import { ServerConfigService } from './server-config.service';
import { NetworkStatusService } from './network-status.service';

let seq = 0;
function event(over: Partial<PlayEventPayload> = {}): PlayEventPayload {
  seq += 1;
  return {
    clientEventId: `evt-${seq}`,
    songId: 's1',
    startedAt: 1_700_000_000_000,
    msPlayed: 200_000,
    durationMs: 300_000,
    reason: 'ended',
    source: 'album',
    device: 'browser',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    ...over,
  };
}

/** The one call shape we assert on: post(url, { events }). Declared so
 *  `post.mock.calls[n][1]` type-checks — an untyped vi.fn() has a zero-length
 *  args tuple, which `bun run typecheck:web-spec` (correctly) rejects. */
type PostMock = ReturnType<
  typeof vi.fn<(url: string, body: { events: PlayEventPayload[] }) => unknown>
>;

/** The events body of the nth post call, asserted present. */
function sentEvents(post: PostMock, n: number): PlayEventPayload[] {
  const call = post.mock.calls[n];
  expect(call).toBeDefined();
  return call![1].events;
}

function setup(opts: { online?: boolean; post?: PostMock } = {}) {
  const online = signal(opts.online ?? true);
  const reconnects = signal(0);
  const post: PostMock =
    opts.post ?? vi.fn(() => of({ inserted: 1, duplicates: 0, rejected: 0 }) as unknown);

  TestBed.configureTestingModule({
    providers: [
      ListeningQueueService,
      { provide: HttpClient, useValue: { post } },
      { provide: ServerConfigService, useValue: { apiUrl: (p: string) => p } },
      { provide: NetworkStatusService, useValue: { online, reconnects } },
    ],
  });
  return { svc: TestBed.inject(ListeningQueueService), post, online, reconnects };
}

beforeEach(() => {
  localStorage.clear();
});

describe('ListeningQueueService', () => {
  it('sends a buffered event and clears it on success', async () => {
    const { svc, post } = setup();
    svc.enqueue(event());
    await Promise.resolve();

    expect(post).toHaveBeenCalledTimes(1);
    expect(sentEvents(post, 0)).toMatchObject([expect.objectContaining({ songId: 's1' })]);
    expect(svc.pendingCount()).toBe(0);
  });

  it('buffers durably before the network, so a crash mid-request loses nothing', () => {
    // Never resolves — mimics a request in flight when the tab dies.
    const { svc } = setup({ post: vi.fn(() => new Promise(() => {}) as never) });
    svc.enqueue(event());
    expect(JSON.parse(localStorage.getItem('nicotind-play-queue') ?? '[]')).toHaveLength(1);
  });

  it('keeps the buffer when the flush fails, and retries on the next enqueue', async () => {
    const post: PostMock = vi.fn(() => throwError(() => new Error('boom')) as unknown);
    const { svc } = setup({ post });
    svc.enqueue(event());
    await Promise.resolve();

    expect(svc.pendingCount()).toBe(1);

    svc.enqueue(event());
    await Promise.resolve();
    // Second attempt carried both events.
    expect(sentEvents(post, 1)).toHaveLength(2);
  });

  it('does not attempt a send while offline', async () => {
    const { svc, post } = setup({ online: false });
    svc.enqueue(event());
    await Promise.resolve();

    expect(post).not.toHaveBeenCalled();
    expect(svc.pendingCount()).toBe(1);
  });

  it('flushes an offline backlog when the device reconnects', async () => {
    const { svc, post, online, reconnects } = setup({ online: false });
    svc.enqueue(event());
    svc.enqueue(event());
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();

    online.set(true);
    reconnects.update((n) => n + 1);
    TestBed.flushEffects();
    await Promise.resolve();

    expect(post).toHaveBeenCalledTimes(1);
    expect(sentEvents(post, 0)).toHaveLength(2);
  });

  it('recovers a buffer left behind by a previous page load', async () => {
    localStorage.setItem('nicotind-play-queue', JSON.stringify([event()]));
    const { svc, post } = setup();

    expect(svc.pendingCount()).toBe(1);
    await svc.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(svc.pendingCount()).toBe(0);
  });

  it('drops only what it sent, keeping anything enqueued mid-flight', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    const post = vi.fn(() => ({
      subscribe: (obs: { next: (v: unknown) => void; complete: () => void }) => {
        resolvePost = (v) => {
          obs.next(v);
          obs.complete();
        };
        return { unsubscribe: () => {} };
      },
    }));
    const { svc } = setup({ post: post as never });

    svc.enqueue(event({ clientEventId: 'first' }));
    // Arrives while the first request is still open.
    svc.enqueue(event({ clientEventId: 'second' }));
    resolvePost({});
    await Promise.resolve();

    const left = JSON.parse(
      localStorage.getItem('nicotind-play-queue') ?? '[]',
    ) as PlayEventPayload[];
    expect(left.map((e) => e.clientEventId)).toEqual(['second']);
  });

  it('bounds the buffer so a long offline stretch cannot grow storage forever', () => {
    const { svc } = setup({ online: false });
    for (let i = 0; i < 250; i += 1) svc.enqueue(event());
    expect(svc.pendingCount()).toBe(200);
  });

  it('survives corrupt storage rather than breaking playback', async () => {
    localStorage.setItem('nicotind-play-queue', 'not json');
    const { svc, post } = setup();
    expect(svc.pendingCount()).toBe(0);
    svc.enqueue(event());
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing buffered', async () => {
    const { svc, post } = setup();
    await svc.flush();
    expect(post).not.toHaveBeenCalled();
  });
});

/** Consent refusal handling (issue #454). */
describe('ListeningQueueService — collection refused', () => {
  const refused = { inserted: 0, duplicates: 0, rejected: 0, collection: { enabled: false } };

  it('stops buffering once the server says collection is off', async () => {
    const post: PostMock = vi.fn(() => of(refused) as unknown);
    const { svc } = setup({ post });

    svc.enqueue(event());
    await Promise.resolve();

    // The refused batch is dropped rather than retried forever...
    expect(svc.pendingCount()).toBe(0);
    // ...and nothing further accumulates.
    svc.enqueue(event());
    svc.enqueue(event());
    expect(svc.pendingCount()).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('resumes immediately when the user turns collection back on', async () => {
    const post: PostMock = vi.fn(() => of(refused) as unknown);
    const { svc } = setup({ post });
    svc.enqueue(event());
    await Promise.resolve();

    svc.resetConsentState();
    svc.enqueue(event());
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps reporting while collection is allowed', async () => {
    const { svc, post } = setup();
    svc.enqueue(event());
    await Promise.resolve();
    svc.enqueue(event());
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
