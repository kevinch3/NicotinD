import { parseChangelogItem } from './changelog';

describe('parseChangelogItem', () => {
  it('parses scope + description + commit link', () => {
    const result = parseChangelogItem(
      '**artists:** admin delete on the Songs tab for albumless files ([6930a32](https://github.com/kevinch3/NicotinD/commit/6930a32))',
    );
    expect(result).toEqual({
      scope: 'artists',
      description: 'admin delete on the Songs tab for albumless files',
      commitSha: '6930a32',
      commitUrl: 'https://github.com/kevinch3/NicotinD/commit/6930a32',
    });
  });

  it('parses description + commit link without scope', () => {
    const result = parseChangelogItem(
      'multi-artist support with parsing, join tables, and linked UI ([e832c17](https://github.com/kevinch3/NicotinD/commit/e832c17))',
    );
    expect(result).toEqual({
      scope: undefined,
      description: 'multi-artist support with parsing, join tables, and linked UI',
      commitSha: 'e832c17',
      commitUrl: 'https://github.com/kevinch3/NicotinD/commit/e832c17',
    });
  });

  it('parses scope + description without commit link', () => {
    const result = parseChangelogItem('**web:** some change without a commit link');
    expect(result).toEqual({
      scope: 'web',
      description: 'some change without a commit link',
      commitSha: undefined,
      commitUrl: undefined,
    });
  });

  it('parses plain text without scope or commit link', () => {
    const result = parseChangelogItem('just a plain description');
    expect(result).toEqual({
      scope: undefined,
      description: 'just a plain description',
      commitSha: undefined,
      commitUrl: undefined,
    });
  });
});
