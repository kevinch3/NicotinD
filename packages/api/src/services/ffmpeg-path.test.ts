import { afterEach, describe, expect, it } from 'bun:test';
import { ffmpegBinary } from './ffmpeg-path.js';

describe('ffmpegBinary', () => {
  afterEach(() => { delete process.env.NICOTIND_FFMPEG_PATH; });
  it('defaults to bare ffmpeg (PATH lookup)', () => {
    delete process.env.NICOTIND_FFMPEG_PATH;
    expect(ffmpegBinary()).toBe('ffmpeg');
  });
  it('honors an explicit absolute path', () => {
    process.env.NICOTIND_FFMPEG_PATH = '/opt/app/resources/ffmpeg';
    expect(ffmpegBinary()).toBe('/opt/app/resources/ffmpeg');
  });
});
