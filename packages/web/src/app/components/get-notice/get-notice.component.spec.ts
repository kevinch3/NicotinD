import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GetNoticeComponent, type NoticeTone } from './get-notice.component';
import { TranslateService } from '../../services/translate.service';
import { setInputValue } from '../../../testing/signal-input';

function render(tone: NoticeTone, dismissible = false) {
  // One fresh component per scenario (signal-input.ts landmine 2).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GetNoticeComponent],
    providers: [
      {
        provide: TranslateService,
        useValue: { lang: signal('en'), revision: signal(0), t: (k: string) => k },
      },
    ],
  });
  const fixture = TestBed.createComponent(GetNoticeComponent);
  setInputValue(fixture.componentInstance.tone, tone);
  setInputValue(fixture.componentInstance.dismissible, dismissible);
  let dismissed = 0;
  fixture.componentInstance.dismiss.subscribe(() => dismissed++);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { box: el.querySelector<HTMLElement>('[data-tone]')!, el, dismissed: () => dismissed };
}

describe('GetNoticeComponent', () => {
  it.each([
    ['error', 'status-error', 'alert'],
    ['warn', 'status-warn', 'status'],
    ['info', 'status-progress', 'status'],
  ] as const)('%s is painted with %s and announced as %s', (tone, token, role) => {
    const { box } = render(tone);
    expect(box.getAttribute('data-tone')).toBe(tone);
    expect(box.classList).toContain(token);
    expect(box.className).not.toMatch(/(red|blue|amber)-\d/);
    expect(box.getAttribute('role')).toBe(role);
  });

  it('offers a dismiss only when asked to', () => {
    expect(render('info').el.querySelector('[data-testid="notice-dismiss"]')).toBeNull();
    const { el, dismissed } = render('error', true);
    el.querySelector<HTMLButtonElement>('[data-testid="notice-dismiss"]')!.click();
    expect(dismissed()).toBe(1);
  });
});
