/** One album a Get could not fetch, with the server's reason when it gave one. */
export interface GetFailure {
  title: string;
  reason: string;
}

/**
 * The text of the one toast that stands for every failed Get on screen: a single
 * album names its reason, several are counted and named. Pure, so the wording is
 * testable apart from the toast plumbing.
 */
export function failureDigest(failures: readonly GetFailure[]): string {
  if (failures.length === 1) {
    const { title, reason } = failures[0]!;
    return reason ? `Couldn't get "${title}" — ${reason}` : `Couldn't get "${title}"`;
  }
  const named = failures.map((f) => `"${f.title}"`).join(', ');
  return `${failures.length} albums couldn't be fetched: ${named}`;
}
