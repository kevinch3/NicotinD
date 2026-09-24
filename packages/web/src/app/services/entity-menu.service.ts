/**
 * EntityMenuService — the one source of an album / artist / genre / playlist
 * tile's actions (issue #1298), the way `SongMenuService.build()` is for a
 * song (docs/song-actions.md), plus the state of the ONE open entity menu.
 *
 * The order is fixed and the same on every page: **Start radio** first (the
 * app's one verb), Play, Play next, Add to queue, Save offline, Open, then a
 * page's `extraActions` last — the same shape as `SongContext.extraActions`.
 * Every verb fetches the entity's tracks on demand through the same API the
 * detail pages use and hands them to the same `PlayerService` methods, so a
 * radio started from a tile is the radio the detail page would start.
 *
 * `open()`/`close()`/`state` drive `EntityMenuHostComponent`, mounted once in
 * the layout: a tile opens the menu at a pointer point (right-click, hold) or
 * anchored to its ⋯ button (hover/keyboard), never with a panel of its own.
 */
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { LibraryFilter } from '@nicotind/core';
import type { TrackAction } from '../components/track-row/track-row.component';
import { toTrack, type BaseSong } from '../lib/track-utils';
import type { Point } from '../lib/menu-position';
import { resolveAlbumRoute, resolveArtistRoute, resolveGenreRoute } from '../lib/route-utils';
import { LibraryApiService } from './api/library-api.service';
import { PlaylistsApiService } from './api/playlists-api.service';
import { PlayerService, type Track } from './player.service';
import { PreserveService } from './preserve.service';
import { ToastService } from './toast.service';

export type EntityRef =
  | { kind: 'album'; id: string; name: string }
  | { kind: 'artist'; id: string; name: string }
  | { kind: 'genre'; value: string }
  | { kind: 'playlist'; id: string; name: string };

export interface EntityMenuContext {
  /** Page-specific items, appended last (curator Hide, Complete album, …). */
  extraActions?: TrackAction[];
}

export interface EntityMenuState {
  actions: TrackAction[];
  /** Open at a pointer point (right-click, hold). */
  at?: Point;
  /** Or anchored under an element (the ⋯ button). */
  anchor?: HTMLElement;
}

/** Songs fetched for an artist from a tile; the detail page pages further. */
const ARTIST_SONG_LIMIT = 200;
const GENRE_SONG_LIMIT = 500;
const RADIO_COUNT = 20;

@Injectable({ providedIn: 'root' })
export class EntityMenuService {
  private readonly player = inject(PlayerService);
  private readonly api = inject(LibraryApiService);
  private readonly playlists = inject(PlaylistsApiService);
  private readonly preserve = inject(PreserveService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  private readonly menu = signal<EntityMenuState | null>(null);
  readonly state = this.menu.asReadonly();
  /** When the open menu appeared (performance.now()); the host's grace period reads it. */
  openedAt = 0;

  open(state: EntityMenuState): void {
    this.openedAt = performance.now();
    this.menu.set({ actions: state.actions, at: state.at, anchor: state.anchor });
  }

  close(): void {
    this.menu.set(null);
  }

  build(ref: EntityRef, ctx: EntityMenuContext = {}): TrackAction[] {
    const actions: TrackAction[] = [
      {
        label: 'Start radio',
        labelKey: 'entityMenu.startRadio',
        action: () => this.startRadio(ref),
      },
      {
        label: 'Play',
        labelKey: 'entityMenu.play',
        action: () =>
          this.withTracks(ref, (tracks) =>
            this.player.playWithContext(tracks, 0, playContextFor(ref)),
          ),
      },
      {
        label: 'Play next',
        labelKey: 'entityMenu.playNext',
        action: () =>
          this.withTracks(ref, (tracks) => {
            // queueNext prepends, so walk backwards to keep the entity's order.
            for (let i = tracks.length - 1; i >= 0; i--) this.player.queueNext(tracks[i]);
          }),
      },
      {
        label: 'Add to queue',
        labelKey: 'entityMenu.addToQueue',
        action: () =>
          this.withTracks(ref, (tracks) => {
            for (const t of tracks) this.player.addToQueue(t);
          }),
      },
      {
        label: 'Save offline',
        labelKey: 'entityMenu.saveOffline',
        action: () =>
          this.withTracks(ref, (tracks) => {
            void this.preserve.preserveCollection(collectionKey(ref), nameOf(ref), tracks);
          }),
      },
      {
        label: 'Open',
        labelKey: 'entityMenu.open',
        action: () => void this.router.navigate(routeFor(ref)),
      },
    ];
    return [...actions, ...(ctx.extraActions ?? [])];
  }

  /**
   * A genre radio is a filter radio (the server picks across the genre, as the
   * home tiles do); every other kind is a list radio anchored on its own songs.
   */
  private startRadio(ref: EntityRef): Promise<void> {
    if (ref.kind === 'genre') {
      const filter = genreFilter(ref.value);
      return this.withTracks(
        ref,
        (tracks) => this.player.startRadioWithFilter(tracks, filter),
        () => firstValueFrom(this.api.getFilterRadio(filter, [], RADIO_COUNT)),
      );
    }
    return this.withTracks(ref, (tracks) =>
      this.player.startRadioWithTracks(tracks, {
        seedIds: tracks.map((t) => t.id),
        name: nameOf(ref),
      }),
    );
  }

  /** Fetch the entity's tracks, then act; one toast on failure or on nothing to play. */
  private async withTracks(
    ref: EntityRef,
    act: (tracks: Track[]) => void,
    fetch: () => Promise<BaseSong[]> = () => this.songsFor(ref),
  ): Promise<void> {
    let tracks: Track[];
    try {
      const songs = await fetch();
      tracks = songs.map((s) => toTrack(s, ref.kind === 'album' ? ref.name : undefined));
    } catch {
      this.toasts.show({ message: "Couldn't load that — try again", kind: 'error' });
      return;
    }
    if (tracks.length === 0) {
      this.toasts.show({ message: 'Nothing to play there yet', kind: 'info' });
      return;
    }
    act(tracks);
  }

  private async songsFor(ref: EntityRef): Promise<BaseSong[]> {
    switch (ref.kind) {
      case 'album':
        return (await firstValueFrom(this.api.getAlbum(ref.id))).song as BaseSong[];
      case 'artist':
        return (await firstValueFrom(
          this.api.getArtistSongs(ref.id, ARTIST_SONG_LIMIT),
        )) as BaseSong[];
      case 'genre':
        return (await firstValueFrom(
          this.api.getSongsByGenre(ref.value, GENRE_SONG_LIMIT),
        )) as BaseSong[];
      case 'playlist':
        return (await firstValueFrom(this.playlists.getPlaylist(ref.id))).songs as BaseSong[];
    }
  }
}

function genreFilter(value: string): LibraryFilter {
  return { genres: [value] } as LibraryFilter;
}

function nameOf(ref: EntityRef): string {
  return ref.kind === 'genre' ? ref.value : ref.name;
}

function collectionKey(ref: EntityRef): string {
  // The detail pages' own keys, so a tile's save and the page's toggle agree.
  switch (ref.kind) {
    case 'album':
      return ref.id;
    case 'artist':
      return `artist-${ref.id}`;
    case 'genre':
      return ref.value;
    case 'playlist':
      return ref.id;
  }
}

function routeFor(ref: EntityRef): string[] {
  switch (ref.kind) {
    case 'album':
      return resolveAlbumRoute(ref.id);
    case 'artist':
      return resolveArtistRoute(ref.id);
    case 'genre':
      return resolveGenreRoute(ref.value);
    case 'playlist':
      return ['/library/playlists', ref.id];
  }
}

function playContextFor(ref: EntityRef): {
  type: 'album' | 'playlist' | 'adhoc';
  id?: string;
  name: string;
} {
  switch (ref.kind) {
    case 'album':
      return { type: 'album', id: ref.id, name: ref.name };
    case 'playlist':
      return { type: 'playlist', id: ref.id, name: ref.name };
    case 'artist':
      return { type: 'adhoc', name: ref.name };
    case 'genre':
      return { type: 'adhoc', name: ref.value };
  }
}
