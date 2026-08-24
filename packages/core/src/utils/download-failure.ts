// Compatibility shim: failure parsing/classification moved to @nicotind/addon-sdk
// (issue #651 item B — the addon-side retry controller needs the same verdict
// the Downloads card uses). Re-exported so in-monorepo @nicotind/core
// consumers keep resolving unchanged.
export * from '@nicotind/addon-sdk/download-failure';
