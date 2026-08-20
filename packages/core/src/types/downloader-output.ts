// Compatibility shim: the downloader-stdout parsers live in @nicotind/addon-sdk
// (only an addon spawns yt-dlp/spotDL now, so only an addon can see that stream).
// Re-exported so in-monorepo @nicotind/core consumers keep resolving unchanged.
export * from '@nicotind/addon-sdk/downloader-output';
