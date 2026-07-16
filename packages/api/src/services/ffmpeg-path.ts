/**
 * Resolve the ffmpeg binary. In the packaged desktop app the bundled ffmpeg
 * lives at an absolute path (asar.unpacked/resources) with no guarantee it's on
 * PATH, so NICOTIND_FFMPEG_PATH wins when set. Server/Docker builds leave it
 * unset and keep the historical PATH lookup.
 */
export function ffmpegBinary(): string {
  const explicit = process.env.NICOTIND_FFMPEG_PATH?.trim();
  return explicit && explicit.length > 0 ? explicit : 'ffmpeg';
}
