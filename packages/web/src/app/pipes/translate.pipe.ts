import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '../services/translate.service';

/**
 * `{{ 'login.title' | t }}` — the call site for runtime i18n (issue #236).
 *
 * **Impure, deliberately.** The obvious design is a pure pipe relying on
 * `t()`'s signal reads to re-render on a language switch. That does not work,
 * and it was measured rather than assumed: a pure pipe memoizes on its
 * arguments, so when only the language changes `transform` is never called
 * again and the signal read never happens — the UI keeps the old language until
 * something else marks the view dirty. The spec asserts the switch end to end,
 * which is what caught it.
 *
 * A direct `{{ i18n.t('key') }}` method call *does* react (also measured), but
 * costs the same per-change-detection call as an impure pipe while being less
 * ergonomic and harder to swap out later.
 *
 * The impurity is made cheap by memoizing on (key, language, params): the
 * per-change-detection work is a string compare and an early return, and the
 * catalog lookup + interpolation only re-runs when something actually changed.
 */
@Pipe({ name: 't', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(TranslateService);
  private key = '';
  private lang = '';
  private paramsKey = '';
  private value = '';

  transform(key: string, params?: Record<string, string | number>): string {
    const lang = this.i18n.lang();
    // Params are usually absent; stringify only when present.
    const paramsKey = params ? JSON.stringify(params) : '';
    if (key === this.key && lang === this.lang && paramsKey === this.paramsKey) {
      return this.value;
    }
    this.key = key;
    this.lang = lang;
    this.paramsKey = paramsKey;
    this.value = this.i18n.t(key, params);
    return this.value;
  }
}
