import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Theme audit Q1 (#1686): the second hue owns "now playing / live", so the
// primary accent keeps "press me" and "you are here". These are the markers
// the audit named; each must use the `accent-2` family and none the primary.
const SRC = __dirname;
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const PRIMARY = /theme-accent(?!-2)/;

/** One CSS rule's body, by its selector. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is in styles.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('"now playing / live" wears the second hue', () => {
  it('the playing row: its title, its eq bars and its buffering spinner', () => {
    const row = read('app/components/track-row/track-row.component.html');
    expect(row).toContain('[class.text-theme-accent-2-text]="isCurrent()"');
    expect(row).toContain('border-t-[var(--theme-accent-2)]');
    expect(row).not.toMatch(PRIMARY);
    expect(rule(read('styles.css'), '.eq-bars > span')).toContain('var(--theme-accent-2)');
  });

  it('the seek fill, its thumb and its focus ring', () => {
    const css = read('styles.css');
    const seek = css.slice(
      css.indexOf('.player-mini-seek .seek-range {'),
      css.indexOf('.eq-bars {'),
    );
    expect(seek.match(/var\(--theme-accent-2\)/g)?.length).toBeGreaterThanOrEqual(8);
    expect(seek).not.toMatch(/var\(--theme-accent\)/);
  });

  it.each([
    'app/components/now-playing/radio-chip/radio-chip.component.html',
    'app/components/now-playing/np-radio-control/np-radio-control.component.html',
  ])('the radio control %s', (file) => {
    const html = read(file);
    expect(html).toContain('theme-accent-2');
    expect(html).not.toMatch(PRIMARY);
  });

  it('the play button stays the one primary fill in the transport', () => {
    const transport = read(
      'app/components/now-playing/now-playing-transport/now-playing-transport.component.html',
    );
    expect(transport).not.toContain('theme-accent-2');
  });
});
