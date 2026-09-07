import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { EntityLinkComponent, type EntityKind } from './entity-link.component';
import { setInputValue } from '../../../testing/signal-input';

function render(kind: EntityKind, id: string | undefined, name = 'Name') {
  TestBed.configureTestingModule({
    imports: [EntityLinkComponent],
    // A catch-all route so the click test's real navigation has somewhere to land.
    providers: [provideRouter([{ path: '**', children: [] }])],
  });
  const fixture = TestBed.createComponent(EntityLinkComponent);
  setInputValue(fixture.componentInstance.kind, kind);
  setInputValue(fixture.componentInstance.id, id);
  setInputValue(fixture.componentInstance.name, name);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, anchor: el.querySelector('a'), span: el.querySelector('span') };
}

describe('EntityLinkComponent', () => {
  afterEach(() => document.documentElement.classList.remove('tv-build'));

  it.each([
    ['album', 'al1', '/library/albums/al1'],
    ['artist', 'ar1', '/library/artists/ar1'],
    ['genre', 'rock', '/library/genres/rock'],
    ['playlist', 'pl1', '/library/playlists/pl1'],
  ] as const)('links a %s to its page', (kind, id, href) => {
    const { anchor } = render(kind, id, 'Some Name');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe(href);
    expect(anchor!.getAttribute('data-testid')).toBe(`entity-link-${kind}`);
    expect(anchor!.hasAttribute('appTvNavItem')).toBe(true);
    expect(anchor!.textContent).toBe('Some Name');
  });

  it('renders a plain span when there is no id', () => {
    const { anchor, span } = render('album', undefined, 'Unknown Album');
    expect(anchor).toBeNull();
    expect(span?.textContent).toBe('Unknown Album');
  });

  it('renders an artist as a span on TV — the TV route tree has no artist page', () => {
    document.documentElement.classList.add('tv-build');
    const { anchor, span } = render('artist', 'ar1', 'TV Artist');
    expect(anchor).toBeNull();
    expect(span?.textContent).toBe('TV Artist');
  });

  it('still links an album on TV (the album route exists there)', () => {
    document.documentElement.classList.add('tv-build');
    const { anchor } = render('album', 'al1');
    expect(anchor?.getAttribute('href')).toBe('/library/albums/al1');
  });

  it('a click emits followed and does not bubble to the host row', () => {
    const { fixture, anchor } = render('album', 'al1');
    let followed = 0;
    let bubbled = 0;
    fixture.componentInstance.followed.subscribe(() => followed++);
    fixture.nativeElement.addEventListener('click', () => bubbled++);
    anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(followed).toBe(1);
    expect(bubbled).toBe(0);
  });
});
