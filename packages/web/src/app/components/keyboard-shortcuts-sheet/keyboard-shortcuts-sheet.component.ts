import { Component, effect, inject } from '@angular/core';
import { KeyboardShortcutsService } from '../../services/keyboard-shortcuts.service';
import { BackButtonService } from '../../services/native/back-button.service';
import { HELP_SHORTCUTS } from '../../lib/keyboard-shortcuts';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';

/** The `?` sheet (#1296): renders the same table the shortcuts dispatch from. */
@Component({
  selector: 'app-keyboard-shortcuts-sheet',
  standalone: true,
  imports: [TranslatePipe, BottomChromeSafeDirective],
  templateUrl: './keyboard-shortcuts-sheet.component.html',
})
export class KeyboardShortcutsSheetComponent {
  readonly shortcuts = inject(KeyboardShortcutsService);
  readonly rows = HELP_SHORTCUTS;
  private readonly backButton = inject(BackButtonService);

  constructor() {
    // Escape closes it through the shared stack (#398), per open.
    effect((onCleanup) => {
      if (!this.shortcuts.helpOpen()) return;
      const unregister = this.backButton.stack.push(() => {
        this.close();
        return true;
      });
      onCleanup(unregister);
    });
  }

  close(): void {
    this.shortcuts.setHelpOpen(false);
  }
}
