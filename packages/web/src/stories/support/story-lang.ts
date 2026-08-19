/**
 * The language the toolbar global currently selects.
 *
 * A module-level holder rather than a parameter because the two halves run in
 * different worlds: the `lang` toolbar global is read by a Storybook decorator,
 * while the language has to be applied inside each story's own Angular injector
 * (`TranslateService` is `providedIn: 'root'`, so every story app gets its own
 * instance and a decorator has no handle on it). The decorator writes here
 * before the story renders; `storyProviders()`'s app initializer reads it.
 *
 * Same shape as `withTvBuild`, which likewise reaches the render by mutating
 * shared state rather than threading a value through.
 */
let storyLang = 'en';

export function setStoryLang(lang: string): void {
  storyLang = lang;
}

export function getStoryLang(): string {
  return storyLang;
}
