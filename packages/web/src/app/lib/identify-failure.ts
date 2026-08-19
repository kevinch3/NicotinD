/**
 * i18n key for an AcoustID identify failure kind (issue #414 taxonomy).
 * Shared by the review metadata-fix modal and the track-info sheet so the
 * kind→copy mapping can't drift between the two surfaces.
 */
export function identifyFailureKey(kind: string): string {
  switch (kind) {
    case 'fpcalc-missing':
      return 'review.identifyFpcalcMissing';
    case 'undecodable':
      return 'review.identifyUndecodable';
    case 'source-error':
      return 'review.identifySourceError';
    case 'file-missing':
      return 'review.identifyFileMissing';
    default:
      return 'review.identifyNoMatch';
  }
}
