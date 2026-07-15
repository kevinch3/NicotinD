import { describe, expect, it } from 'bun:test';
import { updateMode } from './update-mode.js';

describe('updateMode', () => {
  it('notifies on unsigned macOS (cannot apply to an unsigned app)', () => {
    expect(updateMode('darwin', false)).toBe('notify');
  });

  it('applies on signed macOS (future-proofs for when mac signing lands)', () => {
    expect(updateMode('darwin', true)).toBe('apply');
  });

  it('applies on Linux regardless of signing', () => {
    expect(updateMode('linux', false)).toBe('apply');
  });

  it('applies on Windows regardless of signing', () => {
    expect(updateMode('win32', false)).toBe('apply');
  });
});
