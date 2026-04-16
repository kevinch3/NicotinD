import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import type { Track } from '../../services/player.service';

export interface TrackAction {
  label: string;
  icon?: string;
  action: () => void;
  destructive?: boolean;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-track-row',
  imports: [CoverArtComponent],
  templateUrl: './track-row.component.html',
  })
export class TrackRowComponent {
  readonly auth = inject(AuthService);

  readonly track = input.required<Track>();
  readonly indexLabel = input<string | number>();
  readonly subtitle = input<string>();
  readonly duration = input<number>();
  readonly disabled = input(false);
  readonly showRemove = input(false);
  readonly offline = input(false);
  readonly actions = input<TrackAction[]>([]);
  readonly play = output<void>();
  readonly remove = output<void>();

  readonly menuOpen = signal(false);

  @HostListener('document:click')
  closeMenu() { this.menuOpen.set(false); }

  @HostListener('document:keydown.escape')
  closeMenuEscape() { this.menuOpen.set(false); }

  toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    this.menuOpen.update(v => !v);
  }

  runAction(action: TrackAction) {
    this.menuOpen.set(false);
    action.action();
  }

  formatDuration = formatDuration;
}
