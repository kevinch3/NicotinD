/**
 * The demo catalog and its generators (docs/demo-mode.md). Deliberately NOT
 * re-exported from `@nicotind/core`'s index: nothing on the server path needs it,
 * so only the surfaces that build or serve the demo import it, by this path.
 */
export * from './catalog.js';
export * from './cover.js';
export * from './random.js';
export * from './tone.js';
