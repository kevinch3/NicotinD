import { describe, expect, it } from 'bun:test';
import { Journey, OUTCOME_TITLE, outcomeObservation } from './journey';

describe('Journey', () => {
  it('counts steps and emits a step-count metric with the trail', () => {
    const j = new Journey('downloads');
    j.step('open /downloads').step('switch to Recently Added').step('open album');
    expect(j.stepCount).toBe(3);

    const obs = j.summarize();
    const metric = obs.find((o) => o.title === 'Steps to complete');
    expect(metric?.kind).toBe('metric');
    expect(metric?.value).toBe(3);
    expect(metric?.detail).toBe('open /downloads → switch to Recently Added → open album');
  });

  it('emits an enhancement per fallback and a gap per dead-end', () => {
    const j = new Journey('sharing');
    j.step('open album').fallback('share button testid missing').deadEnd('no share link rendered');

    const obs = j.summarize();
    const fallback = obs.find((o) => o.title.startsWith('Fallback needed'));
    const deadEnd = obs.find((o) => o.title.startsWith('Dead-end'));
    expect(fallback?.kind).toBe('enhancement');
    expect(fallback?.severity).toBe('medium');
    expect(deadEnd?.kind).toBe('gap');
    expect(deadEnd?.severity).toBe('high');
  });

  it('always emits the metric even with zero steps', () => {
    const obs = new Journey('empty').summarize();
    expect(obs).toHaveLength(1);
    expect(obs[0]?.value).toBe(0);
    expect(obs[0]?.detail).toBeUndefined();
  });

  it('chains fluently', () => {
    const j = new Journey('f');
    expect(j.step('a').step('b')).toBe(j);
  });
});

describe('outcomeObservation', () => {
  it('uses the stable Outcome title and encodes the status as the value', () => {
    const o = outcomeObservation('playlists', 'success', 'created + deleted');
    expect(o.title).toBe(OUTCOME_TITLE);
    expect(o.value).toBe('success');
    expect(o.severity).toBe('info');
    expect(o.detail).toBe('created + deleted');
  });

  it('grades failure high and partial/degraded low', () => {
    expect(outcomeObservation('f', 'failed').severity).toBe('high');
    expect(outcomeObservation('f', 'partial').severity).toBe('low');
    expect(outcomeObservation('f', 'degraded').severity).toBe('low');
  });
});
