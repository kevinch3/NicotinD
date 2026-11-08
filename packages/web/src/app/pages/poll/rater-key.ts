/**
 * Anonymous per-device rater id: a random UUID kept in localStorage so a
 * returning visitor updates their own votes instead of double-counting.
 * NOT an identity — the server stores it verbatim and ties it to nothing.
 */
import { randomUuid } from '../../lib/uuid';

const STORAGE_KEY = 'nicotind.pollRaterKey';

let inMemoryKey: string | null = null;

export function getRaterKey(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = randomUuid();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / storage denied: stable for this page load at least.
    inMemoryKey ??= randomUuid();
    return inMemoryKey;
  }
}
