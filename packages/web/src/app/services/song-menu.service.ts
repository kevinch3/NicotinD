import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { OfflineModeService } from './offline-mode.service';
import { firstValueFrom } from 'rxjs';
import { PlayerService } from './player.service';
import { PlaylistService } from './playlist.service';
import { PreserveService } from './preserve.service';
import { AuthService } from './auth.service';
import { LibraryApiService } from './api/library-api.service';
import { TransferService } from './transfer.service';
import { TrackInfoService, type TrackInfoFocus, type TrackInfoTarget } from './track-info.service';
import { ConfirmService } from './confirm.service';
import { LikeService } from './like.service';
import { RecommendationExclusionsService } from './recommendation-exclusions.service';
import { ReportTrackService } from './report-track.service';
import { resolveArtistRoute, offlineFind, resolveAlbumRoute } from '../lib/route-utils';
import {
  toTrack,
  offlineTrackAction,
  addToPlaylistAction,
  type BaseSong,
} from '../lib/track-utils';
import type { TrackAction } from '../components/track-row/track-row.component';

export interface SongContext {
  /** Suppress "Go to artist" (e.g. on the artist page — redundant there). */
  hideGoToArtist?: boolean;
  /** Suppress "Go to album" (e.g. on the album page). */
  hideGoToAlbum?: boolean;
  /** Offer "Remove from playlist" wired to this callback. */
  onRemoveFromPlaylist?: () => void;
  /** Page-unique actions appended last. */
  extraActions?: TrackAction[];
}

/**
 * Single source of truth for a song's `⋯` menu. Every listing calls `build()`
 * so the common action set is guaranteed everywhere and contextual actions are
 * declared, not re-coded. See docs/song-actions.md.
 */
@Injectable({ providedIn: 'root' })
export class SongMenuService {
  private readonly player = inject(PlayerService);
  private readonly playlists = inject(PlaylistService);
  private readonly preserve = inject(PreserveService);
  private readonly router = inject(Router);
  private readonly offline = inject(OfflineModeService).isOffline;
  private readonly auth = inject(AuthService);
  private readonly api = inject(LibraryApiService);
  private readonly transfers = inject(TransferService);
  private readonly trackInfo = inject(TrackInfoService);
  private readonly confirm = inject(ConfirmService);
  private readonly likes = inject(LikeService);
  private readonly exclusions = inject(RecommendationExclusionsService);
  private readonly report = inject(ReportTrackService);

  build(song: BaseSong, ctx: SongContext = {}): TrackAction[] {
    const track = toTrack(song);
    const actions: TrackAction[] = [
      // Like/Unlike leads the menu — a primary gesture (issue #225). Label
      // reflects current state; the toggle adds/removes it from Liked Songs.
      {
        label: this.likes.isLiked(song.id) ? 'Unlike' : 'Like',
        labelKey: this.likes.isLiked(song.id) ? 'song.unlike' : 'song.like',
        icon: this.likes.isLiked(song.id) ? 'heart-filled' : 'heart',
        group: 'play',
        quick: true,
        action: () => void this.likes.toggle(song.id),
      },
      {
        label: 'Add to queue',
        labelKey: 'song.addToQueue',
        icon: 'queue',
        group: 'play',
        quick: true,
        action: () => this.player.addToQueue(track),
      },
      {
        label: 'Play next',
        labelKey: 'song.playNext',
        icon: 'play-next',
        group: 'play',
        quick: true,
        action: () => this.player.queueNext(track),
      },
      {
        label: 'Start radio',
        labelKey: 'song.startRadio',
        icon: 'radio',
        group: 'play',
        action: () => this.player.startRadio(track),
      },
    ];

    if (song.artistId && !ctx.hideGoToArtist) {
      // A joint or featured credit: one entry per credited artist, primary
      // first, so the others can be reached too (#2010). A single credit stays
      // a plain item.
      const credits = [...(song.artists ?? [])].sort(
        (a, b) => Number(b.role === 'primary') - Number(a.role === 'primary'),
      );
      actions.push({
        label: 'Go to artist',
        labelKey: 'song.goToArtist',
        icon: 'user',
        group: 'goto',
        ...(credits.length > 1
          ? {
              children: () =>
                credits.map((credit, i) => ({
                  // Two credits can share a name; a label is also a row's key.
                  label:
                    credits.findIndex((c) => c.name === credit.name) === i
                      ? credit.name
                      : `${credit.name} (${i + 1})`,
                  icon: 'user' as const,
                  action: () =>
                    this.offline()
                      ? void this.router.navigate(...offlineFind(credit.name))
                      : void this.router.navigate(resolveArtistRoute(credit.id)),
                })),
            }
          : {}),
        action: () => {
          const primary = song.artists?.find((a) => a.role === 'primary');
          // Offline the artist page needs the server: open the saved songs
          // filtered to the name instead (#1751).
          if (this.offline())
            return void this.router.navigate(...offlineFind(primary?.name ?? song.artist));
          void this.router.navigate(resolveArtistRoute(primary?.id ?? song.artistId));
        },
      });
    }
    if (song.albumId && !ctx.hideGoToAlbum) {
      actions.push({
        label: 'Go to album',
        labelKey: 'song.goToAlbum',
        icon: 'disc-album',
        group: 'goto',
        action: () => {
          if (this.offline() && song.album)
            return void this.router.navigate(...offlineFind(song.album));
          void this.router.navigate(resolveAlbumRoute(song.albumId));
        },
      });
    }

    const infoTarget: TrackInfoTarget = {
      songId: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverArt: song.coverArt ?? null,
      coverRev: song.coverRev,
      albumId: song.albumId ?? null,
    };
    actions.push(addToPlaylistAction(this.playlists, song.id));
    actions.push(offlineTrackAction(this.preserve, track));
    actions.push({
      label: 'Song info',
      labelKey: 'song.info',
      icon: 'info',
      group: 'info',
      action: () => this.trackInfo.open(infoTarget),
    });

    // A personal veto on the feeds (docs/radio.md "Per-user exclusions"): the
    // song stays in the library, it just stops being *proposed* to this listener.
    actions.push(
      this.exclusions.isExcluded(song.id)
        ? {
            label: 'Recommend again',
            labelKey: 'song.recommendAgain',
            icon: 'thumbs-up',
            group: 'feedback',
            action: () => void this.exclusions.restore(song.id),
          }
        : {
            label: "Don't recommend this",
            labelKey: 'song.dontRecommend',
            icon: 'thumbs-down',
            group: 'feedback',
            action: () => void this.exclusions.exclude(song.id),
          },
    );

    // The other half of the pair above: the veto says nothing is wrong, the
    // report says something is (docs/mcp-agent.md "Listeners write to the same
    // queue"). `not_for_me` inside the dialog routes back to `exclude()`.
    actions.push({
      label: 'Report this track',
      labelKey: 'report.menuItem',
      icon: 'flag',
      group: 'feedback',
      action: () => this.report.open(song.id),
    });

    // Role items sit behind a submenu, so the menu stays the same length for
    // everyone else (#2018). Acquiring needs the server.
    if (this.auth.canAcquire() && song.artistId && !ctx.hideGoToArtist && !this.offline()) {
      const primary = song.artists?.find((a) => a.role === 'primary');
      const artistName = primary?.name ?? song.artist;
      actions.push({
        label: 'Get more',
        labelKey: 'song.getMore',
        icon: 'download',
        group: 'role',
        action: () => {},
        children: () => [
          {
            // The artist page opens on its discography, where the albums the
            // library lacks are already marked.
            label: 'More by this artist',
            labelKey: 'song.moreByArtist',
            labelParams: { artist: artistName },
            icon: 'user',
            action: () =>
              void this.router.navigate(resolveArtistRoute(primary?.id ?? song.artistId)),
          },
        ],
      });
    }

    // A curator's song actions, one tap in, on every page (#2017). They all
    // write to the server.
    if (this.auth.canCurate() && !this.offline()) {
      const info = (focus: TrackInfoFocus) => () => this.trackInfo.open(infoTarget, { focus });
      actions.push({
        label: 'Curate',
        labelKey: 'song.curate',
        icon: 'edit',
        group: 'role',
        action: () => {},
        children: async () => [
          {
            label: 'Edit tags',
            labelKey: 'song.curateTags',
            icon: 'tag',
            action: info('tags'),
          },
          {
            label: 'Fix artist credit',
            labelKey: 'song.curateArtist',
            icon: 'user',
            action: info('artist'),
          },
          ...((await this.canIdentify())
            ? [
                {
                  label: 'Identify',
                  labelKey: 'song.curateIdentify',
                  icon: 'search' as const,
                  action: info('identify'),
                },
              ]
            : []),
          {
            label: 'Set genre',
            labelKey: 'song.curateGenre',
            icon: 'music',
            action: info('genre'),
          },
          {
            label: 'Remove from library',
            labelKey: 'song.removeFromLibrary',
            icon: 'delete',
            group: 'remove',
            destructive: true,
            action: () => void this.removeFromLibrary(song.id, song.title),
          },
        ],
      });
    }
    if (ctx.onRemoveFromPlaylist) {
      actions.push({
        label: 'Remove from playlist',
        labelKey: 'song.removeFromPlaylist',
        icon: 'close',
        group: 'remove',
        destructive: true,
        action: ctx.onRemoveFromPlaylist,
      });
    }
    if (ctx.extraActions?.length) actions.push(...ctx.extraActions);

    return actions;
  }

  private identify?: Promise<boolean>;
  /** Whether the server can fingerprint a song; asked once, when a Curate menu first opens. */
  private canIdentify(): Promise<boolean> {
    return (this.identify ??= firstValueFrom(this.api.getIdentifyAvailable()).then(
      (r) => r.available,
      () => false,
    ));
  }

  /** Confirm → delete → mark deleted. Listings filter through
   * transferService.deletedSongIds(), so no per-page prune is needed. */
  private async removeFromLibrary(id: string, title: string): Promise<void> {
    if (!(await this.confirm.ask(`Remove "${title}" from library?`))) return;
    await firstValueFrom(this.api.deleteSongs([id]));
    this.transfers.addDeletedIds([id]);
  }
}
