import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PlayerService } from './player.service';
import { PlaylistService } from './playlist.service';
import { PreserveService } from './preserve.service';
import { AuthService } from './auth.service';
import { LibraryApiService } from './api/library-api.service';
import { TransferService } from './transfer.service';
import { TrackInfoService } from './track-info.service';
import { ConfirmService } from './confirm.service';
import { LikeService } from './like.service';
import { RecommendationExclusionsService } from './recommendation-exclusions.service';
import { ReportTrackService } from './report-track.service';
import { resolveArtistRoute, resolveAlbumRoute } from '../lib/route-utils';
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
  /** Offer admin-gated "Remove from library". */
  removable?: boolean;
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
        action: () => void this.likes.toggle(song.id),
      },
      { label: 'Add to queue', action: () => this.player.addToQueue(track) },
      { label: 'Play next', action: () => this.player.queueNext(track) },
      { label: 'Start radio', action: () => this.player.startRadio(track) },
    ];

    if (song.artistId && !ctx.hideGoToArtist) {
      actions.push({
        label: 'Go to artist',
        action: () => void this.router.navigate(resolveArtistRoute(song.artistId)),
      });
    }
    if (song.albumId && !ctx.hideGoToAlbum) {
      actions.push({
        label: 'Go to album',
        action: () => void this.router.navigate(resolveAlbumRoute(song.albumId)),
      });
    }

    actions.push(addToPlaylistAction(this.playlists, song.id));
    actions.push(offlineTrackAction(this.preserve, track));
    actions.push({
      label: 'Song info',
      action: () =>
        this.trackInfo.open({
          songId: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          coverArt: song.coverArt ?? null,
        }),
    });

    // A personal veto on the feeds (docs/radio.md "Per-user exclusions"): the
    // song stays in the library, it just stops being *proposed* to this listener.
    actions.push(
      this.exclusions.isExcluded(song.id)
        ? { label: 'Recommend again', action: () => void this.exclusions.restore(song.id) }
        : { label: "Don't recommend this", action: () => void this.exclusions.exclude(song.id) },
    );

    // The other half of the pair above: the veto says nothing is wrong, the
    // report says something is (docs/mcp-agent.md "Listeners write to the same
    // queue"). `not_for_me` inside the dialog routes back to `exclude()`.
    actions.push({
      label: 'Report this track',
      labelKey: 'report.menuItem',
      action: () => this.report.open(song.id),
    });

    if (ctx.removable && this.auth.canCurate()) {
      actions.push({
        label: 'Remove from library',
        destructive: true,
        action: () => void this.removeFromLibrary(song.id, song.title),
      });
    }
    if (ctx.onRemoveFromPlaylist) {
      actions.push({
        label: 'Remove from playlist',
        destructive: true,
        action: ctx.onRemoveFromPlaylist,
      });
    }
    if (ctx.extraActions?.length) actions.push(...ctx.extraActions);

    return actions;
  }

  /** Confirm → delete → mark deleted. Listings filter through
   * transferService.deletedSongIds(), so no per-page prune is needed. */
  private async removeFromLibrary(id: string, title: string): Promise<void> {
    if (!(await this.confirm.ask(`Remove "${title}" from library?`))) return;
    await firstValueFrom(this.api.deleteSongs([id]));
    this.transfers.addDeletedIds([id]);
  }
}
