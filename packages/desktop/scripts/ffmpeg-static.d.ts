/**
 * `ffmpeg-static` ships without types. Its module.exports IS the resolved
 * absolute path to a static ffmpeg binary for the current platform/arch
 * (https://github.com/eugeneware/ffmpeg-static) — declared ambiently here so
 * `prepare-resources.ts` typechecks whether or not the package has actually
 * been `bun install`-ed (e.g. in a sandbox with no network access).
 */
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null;
  export default ffmpegPath;
}
