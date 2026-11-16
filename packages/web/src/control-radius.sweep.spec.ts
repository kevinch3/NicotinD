import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// The radius rule (theme audit Q4 A, #1686): `rounded-lg` for controls,
// `rounded-xl` for cards, `rounded-full` for pills. This checks the half that
// can be checked from markup: a button, text field, select or textarea never
// uses the 4px (`rounded`) or 6px (`rounded-md`) corner.
const APP = join(__dirname, 'app');

function templates(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return templates(p);
    return name.endsWith('.html') ? [p] : [];
  });
}

const CONTROL = /<(button|input|select|textarea)\b([^>]*)>/gs;
const SMALL_RADIUS = /(?<![\w:-])rounded(?:-md)?(?![\w-])/;
/** A checkbox, radio, range, file or colour input draws its own shape. */
const OWN_SHAPE = /type="(?:checkbox|radio|range|file|color)"/;
/** A control fixed at 24px or less: an 8px corner would make it a blob. */
const TINY = /(?<![\w:-])(?:w|h|size)-(?:2|2\.5|3|3\.5|4|5|6)(?![\w.-])/;

function offenders(html: string): string[] {
  return [...html.matchAll(CONTROL)]
    .filter(
      ([, , attrs]) => SMALL_RADIUS.test(attrs!) && !OWN_SHAPE.test(attrs!) && !TINY.test(attrs!),
    )
    .map(([tag]) => tag.replace(/\s+/g, ' ').slice(0, 120));
}

describe('a control has the control radius (#1686)', () => {
  it('no button or field uses rounded or rounded-md', () => {
    // TV rows are 10-foot cards that happen to be buttons, with their own scale.
    const files = templates(APP).filter((p) => !relative(APP, p).startsWith('pages/tv'));
    expect(files.length, 'templates swept').toBeGreaterThan(100);
    const found = files.flatMap((p) =>
      offenders(readFileSync(p, 'utf8')).map((tag) => `${relative(APP, p)}: ${tag}`),
    );
    expect(found).toEqual([]);
  });

  it('the rule has something to hold: most controls carry rounded-lg', () => {
    const lg = templates(APP).reduce(
      (n, p) =>
        n +
        [...readFileSync(p, 'utf8').matchAll(CONTROL)].filter(([, , a]) =>
          /\brounded-lg\b/.test(a!),
        ).length,
      0,
    );
    expect(lg).toBeGreaterThan(300);
  });

  it('the patterns catch what they are for', () => {
    expect(offenders('<button class="px-2 rounded text-sm">')).toHaveLength(1);
    expect(offenders('<input class="rounded-md border">')).toHaveLength(1);
    expect(offenders('<button class="rounded-lg">')).toEqual([]);
    expect(offenders('<button class="rounded-full">')).toEqual([]);
    expect(offenders('<input type="checkbox" class="rounded">')).toEqual([]);
    expect(offenders('<button class="w-5 h-5 rounded">')).toEqual([]);
    expect(offenders('<div class="rounded">')).toEqual([]);
  });
});
