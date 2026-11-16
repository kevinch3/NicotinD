import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { washFor } from './cover-wash.directive';

const root = document.documentElement;
const TOKENS: Record<string, string> = {
  '--theme-bg': '#0a0a0f',
  '--theme-surface': '#18181f',
  '--theme-text-primary': '#f4f4f5',
  '--theme-text-secondary': '#a8a8b4',
  '--theme-text-muted': '#9a9aa6',
};

describe('washFor (#1687)', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(TOKENS)) root.style.setProperty(k, v);
  });
  afterEach(() => {
    for (const k of Object.keys(TOKENS)) root.style.removeProperty(k);
  });

  it('gives a translucent tint of the dominant colour, measured against the preset', () => {
    const wash = washFor('rgb(180, 40, 40)', 'bg');
    expect(wash).toMatch(/^rgb\(180 40 40 \/ 0\.\d+\)$/);
  });

  it('is weaker over the card than over the page when the card leaves less headroom', () => {
    const alpha = (css: string | null) => Number(/\/ ([\d.]+)\)/.exec(css ?? '')?.[1] ?? 0);
    const dominant = 'rgb(230, 230, 120)';
    expect(alpha(washFor(dominant, 'surface'))).toBeLessThanOrEqual(alpha(washFor(dominant, 'bg')));
  });

  it('gives nothing for a cover with no dominant colour, or one it cannot parse', () => {
    expect(washFor(undefined, 'bg')).toBeNull();
    expect(washFor('not a colour', 'bg')).toBeNull();
  });

  it('gives nothing when the preset tokens cannot be read', () => {
    root.style.removeProperty('--theme-text-muted');
    expect(washFor('rgb(180, 40, 40)', 'bg')).toBeNull();
  });
});
