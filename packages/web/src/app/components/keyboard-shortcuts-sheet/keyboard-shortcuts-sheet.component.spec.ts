import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { KeyboardShortcutsSheetComponent } from './keyboard-shortcuts-sheet.component';
import { KeyboardShortcutsService } from '../../services/keyboard-shortcuts.service';
import { BackButtonService } from '../../services/native/back-button.service';
import { PlayerService } from '../../services/player.service';
import { LikeService } from '../../services/like.service';
import { HELP_SHORTCUTS } from '../../lib/keyboard-shortcuts';

function setup() {
  TestBed.configureTestingModule({
    imports: [KeyboardShortcutsSheetComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: {} },
      { provide: LikeService, useValue: {} },
    ],
  });
  const fixture = TestBed.createComponent(KeyboardShortcutsSheetComponent);
  fixture.detectChanges();
  const service = TestBed.inject(KeyboardShortcutsService);
  const back = TestBed.inject(BackButtonService);
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, service, back, el };
}

describe('KeyboardShortcutsSheetComponent', () => {
  it('renders nothing until opened', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="shortcuts-sheet"]')).toBeNull();
  });

  it('renders one row per entry of the dispatch table (no drift)', () => {
    const { fixture, service, el } = setup();
    service.setHelpOpen(true);
    fixture.detectChanges();
    const rows = el.querySelectorAll('[data-testid="shortcuts-row"]');
    expect(rows.length).toBe(HELP_SHORTCUTS.length);
    expect(rows[0]!.textContent).toContain('Space');
  });

  it('Escape (the shared back stack) closes it, and only while it is open', () => {
    const { fixture, service, back } = setup();
    expect(back.stack.handleBack()).toBe(false);
    service.setHelpOpen(true);
    fixture.detectChanges();
    expect(back.stack.handleBack()).toBe(true);
    expect(service.helpOpen()).toBe(false);
    fixture.detectChanges();
    expect(back.stack.handleBack()).toBe(false);
  });

  it('the close button closes it', () => {
    const { fixture, service, el } = setup();
    service.setHelpOpen(true);
    fixture.detectChanges();
    (el.querySelector('[data-testid="shortcuts-sheet-close"]') as HTMLButtonElement).click();
    expect(service.helpOpen()).toBe(false);
  });
});
