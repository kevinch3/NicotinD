import { Component, inject, input, output, signal } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { CoverArtComponent } from '../../cover-art/cover-art.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';

@Component({
  selector: 'app-now-playing-queue-panel',
  imports: [CoverArtComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './now-playing-queue-panel.component.html',
})
export class NowPlayingQueuePanelComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);

  readonly resizing = input(false);
  readonly resizeStart = output<PointerEvent>();

  readonly dragSourceIndex = signal<number | null>(null);
  readonly dropTargetIndex = signal<number | null>(null);

  jumpToTrack(index: number): void {
    if (this.dragSourceIndex() !== null) return;
    this.player.jumpToQueueIndex(index);
  }

  clearQueue(): void {
    this.player.clearQueue();
  }

  removeFromQueue(index: number): void {
    this.player.removeFromQueue(index);
  }

  onQueueDragStart(event: DragEvent, index: number): void {
    this.dragSourceIndex.set(index);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  onQueueDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    if (this.dragSourceIndex() !== null) this.dropTargetIndex.set(index);
  }

  onQueueDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    const from = this.dragSourceIndex();
    this.dragSourceIndex.set(null);
    this.dropTargetIndex.set(null);
    if (from !== null && from !== index) this.player.moveInQueue(from, index);
  }

  onQueueDragEnd(): void {
    this.dragSourceIndex.set(null);
    this.dropTargetIndex.set(null);
  }
}
