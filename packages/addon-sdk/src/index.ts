// @nicotind/addon-sdk — the addon-facing contract, published so third-party
// addons build against a stable surface without depending on all of @nicotind/core.
//
// Scope (protocol + shared helpers, a clean leaf: zod + pino only):
//   - plugin manifest contract an addon declares (manifest.ts)
//   - acquisition addon protocol v1 DTOs / schemas / negotiation (addon.ts)
//   - capability risk copy for consent surfaces (addon-capability-risk.ts)
//   - published JSON-Schema builder for the protocol (addon-protocol-schema.ts)
//   - hunt query builders + title matching an acquisition addon reuses
//   - per-track failure parsing/classification, shared by an addon's own
//     retry controller and the Downloads card (download-failure.ts)
//   - a leaf logger (own copy, so the SDK never depends back into core)
//
// @nicotind/core re-exports every symbol here, so in-monorepo import sites that
// still say `from '@nicotind/core'` keep working unchanged.

export * from './manifest.js';
export * from './addon.js';
export * from './addon-capability-risk.js';
export * from './addon-protocol-schema.js';
export * from './hunt-queries.js';
export * from './title-match.js';
export * from './downloader-output.js';
export * from './download-failure.js';
export * from './logger.js';
