import { Component, input, output } from '@angular/core';
import { HOME_VIEWS, type HomeView } from '@nicotind/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Shelves | Mosaic — the home view switch (issue #1300). A radiogroup styled
 * like the Library tabs; the parent decides where it sits (floating over the
 * mosaic field, in flow above the shelves) and what happens on a pick.
 */
@Component({
  selector: 'app-home-view-switch',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './home-view-switch.component.html',
})
export class HomeViewSwitchComponent {
  // Not `input.required`: the JIT test harness cannot bind a nested
  // component's signal input (src/testing/signal-input.ts).
  readonly view = input<HomeView>('mosaic');
  readonly viewSelected = output<HomeView>();
  readonly options = HOME_VIEWS;

  labelKey(view: HomeView): string {
    return view === 'mosaic' ? 'home.viewMosaic' : 'home.viewShelves';
  }

  pick(view: HomeView): void {
    if (view !== this.view()) this.viewSelected.emit(view);
  }
}
