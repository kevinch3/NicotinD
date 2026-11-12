/** One album a Get could not fetch, with the server's reason when it gave one. */
export interface GetFailure {
  title: string;
  reason: string;
}

/** `TranslateService.t`'s shape, so the digest stays pure and testable without Angular. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The text of the one toast that stands for every failed Get on screen: a single
 * album names its reason, several are counted and named.
 */
export function failureDigest(failures: readonly GetFailure[], t: Translate): string {
  if (failures.length === 1) {
    const { title, reason } = failures[0]!;
    return reason
      ? t('getToast.failedOne', { title, reason })
      : t('getToast.failedOneNoReason', { title });
  }
  const names = failures.map((f) => t('getToast.quotedTitle', { title: f.title })).join(', ');
  return t('getToast.failedMany', { count: failures.length, names });
}
