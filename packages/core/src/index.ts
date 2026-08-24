// Types
export * from './types/acquire.js';
export * from './types/import.js';
export * from './types/addon.js';
export * from './types/downloader-output.js';
export * from './title-match.js';
export * from './types/acquisition-candidate.js';
export * from './types/classify-acquire-url.js';
export * from './types/acquire-as.js';
export * from './types/archive.js';
export * from './types/config.js';
export * from './types/spotify.js';
export * from './types/navidrome.js';
export * from './types/nicotind.js';
export * from './types/provider.js';
export * from './types/track-analysis.js';
export * from './types/artist-info.js';
export * from './types/processing.js';
export * from './types/metadata-fix.js';
export * from './types/lyrics.js';
export * from './types/waveform.js';
export * from './types/library-filter.js';
export * from './types/origin.js';
export * from './types/radio-poll.js';

// Role ladder (capability helpers shared by API guards + web gating)
export * from './roles.js';

// slskd hunt query builders (shared by the API hunter + web hunt modal)
export * from './hunt-queries.js';

// Pairing / TV sign-in code alphabet (shared by the API minter + web scanner)
export * from './pairing-code.js';

// Plugin SDK (capability contracts + manifest)
export * from './plugin/index.js';

// Utils
export * from './utils/logger.js';
export * from './utils/crypto.js';
export * from './utils/errors.js';
export * from './utils/folder-name.js';
export * from './utils/download-title.js';
export * from './utils/download-failure.js';
export * from './utils/expand-home.js';

// Version comparison (shared: server update-check + web APK self-update)
export * from './version.js';
export * from './addon-capability-risk.js';
export * from './addon-protocol-schema.js';

// Curated addon catalog (issue #517) — marketplace entries + compose snippet gen
export * from './addon-catalog.js';
