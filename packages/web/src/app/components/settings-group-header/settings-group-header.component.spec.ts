import { TestBed } from '@angular/core/testing';
import { SettingsGroupHeaderComponent } from './settings-group-header.component';
import { setInputValue } from '../../../testing/signal-input';

describe('SettingsGroupHeaderComponent', () => {
  it('renders the icon, title and description', () => {
    TestBed.configureTestingModule({ imports: [SettingsGroupHeaderComponent] });
    const fixture = TestBed.createComponent(SettingsGroupHeaderComponent);
    setInputValue(fixture.componentInstance.icon, 'palette');
    setInputValue(fixture.componentInstance.title, 'Appearance');
    setInputValue(fixture.componentInstance.description, 'Theme and language');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Appearance');
    expect(el.querySelector('p')?.textContent?.trim()).toBe('Theme and language');
  });
});
