import { TestBed, getTestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { HIDDEN_GRACE_MS, LibraryEventsService } from './library-events.service';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';
import { LibraryApiService } from './api/library-api.service';
import { SetupService } from './setup.service';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

const live: LibraryEventsService[] = [];
const offline = signal(false);

function setup(token: string | null = 't0k') {
  offline.set(false);
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  const invalidate = vi.fn();
  getTestBed().resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LibraryEventsService,
      { provide: AuthService, useValue: { token: () => token, mediaToken: () => token } },
      {
        provide: ServerConfigService,
        useValue: { sseUrl: (p: string, t: string) => `${p}?token=${t}` },
      },
      { provide: LibraryApiService, useValue: { invalidateLibraryReads: invalidate } },
      { provide: SetupService, useValue: { isOffline: offline } },
    ],
  });
  const svc = TestBed.inject(LibraryEventsService);
  live.push(svc);
  return { svc, invalidate };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('LibraryEventsService', () => {
  afterEach(() => {
    for (const s of live.splice(0)) s.stop();
    vi.useRealTimers();
    setVisibility('visible');
    vi.unstubAllGlobals();
  });

  it('opens one stream through sseUrl when started with a token, none without', () => {
    setVisibility('visible');
    const { svc } = setup();
    svc.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/library/events?token=t0k');
    FakeEventSource.instances[0]!.onopen!();
    expect(svc.connected()).toBe(true);
    svc.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(svc.connected()).toBe(false);

    const anon = setup(null);
    anon.svc.start();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('fans events out to the right signals and invalidates cached reads', () => {
    setVisibility('visible');
    const { svc, invalidate } = setup();
    svc.start();
    const src = FakeEventSource.instances[0]!;
    src.emit('library', {
      seq: 1,
      at: 1,
      event: { type: 'songs.landed', songIds: ['s1'], albumIds: ['a1'] },
    });
    src.emit('library', {
      seq: 2,
      at: 2,
      event: { type: 'songs.deleted', songIds: ['s9'], albumIds: ['a9'] },
    });
    src.emit('library', {
      seq: 3,
      at: 3,
      event: {
        type: 'artwork.changed',
        changes: [
          { kind: 'album', id: 'a1', rev: 42 },
          { kind: 'artist', id: 'ar1', rev: 7 },
        ],
      },
    });
    const jobs: string[] = [];
    svc.jobsChanged$.subscribe((id) => jobs.push(id));
    src.emit('library', { seq: 4, at: 4, event: { type: 'job.changed', jobId: 'j1' } });
    expect([...svc.landedAlbumIds()]).toEqual(['a1']);
    expect([...svc.deletedSongIds()]).toEqual(['s9']);
    expect(svc.changedAlbums().get('a1')).toBe(1);
    expect(svc.changedAlbums().get('a9')).toBe(2);
    expect(svc.artworkVersions().get('a1')).toBe(42);
    expect(svc.artistArtworkVersions().get('ar1')).toBe(7);
    expect(svc.artworkVersions().has('ar1')).toBe(false);
    expect(jobs).toEqual(['j1']);
    expect(invalidate).toHaveBeenCalled();
    svc.consumeLanded(['a1']);
    expect(svc.landedAlbumIds().size).toBe(0);
  });

  it('a cover rev never rewinds: an older frame for the same album is ignored (#1666)', () => {
    const { svc } = setup();
    svc.apply({ type: 'artwork.changed', changes: [{ kind: 'album', id: 'a1', rev: 3 }] }, 1);
    svc.apply({ type: 'artwork.changed', changes: [{ kind: 'album', id: 'a1', rev: 2 }] }, 2);
    expect(svc.artworkVersions().get('a1')).toBe(3);
  });

  it('a sequence hole or an explicit resync drops the caches and bumps resync', () => {
    setVisibility('visible');
    const { svc, invalidate } = setup();
    svc.start();
    const src = FakeEventSource.instances[0]!;
    src.emit('library', { seq: 1, at: 1, event: { type: 'job.changed', jobId: 'a' } });
    invalidate.mockClear();
    src.emit('library', { seq: 5, at: 5, event: { type: 'job.changed', jobId: 'b' } });
    expect(svc.resync()).toBe(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    src.emit('resync', {});
    expect(svc.resync()).toBe(2);
  });

  it('lets go of the stream 30 s after the tab hides and reopens from the last seq on return', () => {
    vi.useFakeTimers();
    setVisibility('visible');
    const { svc } = setup();
    svc.start();
    const first = FakeEventSource.instances[0]!;
    first.emit('library', { seq: 7, at: 7, event: { type: 'job.changed', jobId: 'x' } });
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(2);
    expect(first.closed).toBe(true);
    setVisibility('visible');
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('since=7');
    svc.stop();
  });

  it('opens no stream while offline', () => {
    setVisibility('visible');
    const { svc } = setup();
    offline.set(true);
    svc.start();
    TestBed.tick();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('closes the stream when the app goes offline and reopens from the last seq on reconnect', () => {
    setVisibility('visible');
    const { svc } = setup();
    svc.start();
    TestBed.tick();
    const first = FakeEventSource.instances[0]!;
    first.emit('library', { seq: 4, at: 4, event: { type: 'job.changed', jobId: 'x' } });

    offline.set(true);
    TestBed.tick();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    offline.set(false);
    TestBed.tick();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('since=4');
  });

  it('a stopped service no longer follows connectivity', () => {
    setVisibility('visible');
    const { svc } = setup();
    svc.start();
    TestBed.tick();
    svc.stop();
    offline.set(true);
    TestBed.tick();
    offline.set(false);
    TestBed.tick();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
