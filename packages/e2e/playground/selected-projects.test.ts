import { describe, expect, it } from 'bun:test';
import { selectedProjects, serverNeeds } from '../selected-projects';

describe('serverNeeds', () => {
  it('the whole suite starts every server', () => {
    expect(serverNeeds(['test'])).toEqual({ onboarding: true, tv: true });
  });

  it('a chromium subset starts neither optional server', () => {
    expect(serverNeeds(['test', '--project=setup', '--project', 'chromium', 'get-'])).toEqual({
      onboarding: false,
      tv: false,
    });
  });

  it('asks for each only with its project', () => {
    expect(serverNeeds(['--project=onboarding'])).toEqual({ onboarding: true, tv: false });
    expect(serverNeeds(['--project=tv-setup', '--project=tv'])).toEqual({
      onboarding: false,
      tv: true,
    });
  });

  it('reads both flag spellings', () => {
    expect(selectedProjects(['--project', 'a', '--project=b'])).toEqual(['a', 'b']);
  });
});
