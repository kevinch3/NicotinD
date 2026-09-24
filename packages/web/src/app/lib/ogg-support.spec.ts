import { describe, expect, it } from 'vitest';
import { probeOggOpus } from './ogg-support';

const element = (answers: Record<string, string>) => () => ({
  canPlayType: (type: string) => answers[type] ?? '',
});

describe('probeOggOpus (#1254)', () => {
  it('says yes when the element plays Ogg-Opus', () => {
    expect(probeOggOpus(element({ 'audio/ogg; codecs="opus"': 'probably' }))).toBe('yes');
  });

  it('says no only when the element plays mp3 but not Ogg-Opus — an old Safari', () => {
    expect(probeOggOpus(element({ 'audio/mpeg': 'maybe' }))).toBe('no');
  });

  it('is unknown when the element answers nothing, so a test DOM is not an old Safari', () => {
    expect(probeOggOpus(element({}))).toBe('unknown');
    expect(probeOggOpus(() => null)).toBe('unknown');
  });
});
