/** Numeric dot-segment compare: >0 when `a` is newer than `b`. Non-numeric segments compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.');
  const pb = b.replace(/^v/, '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0) || 0;
    const nb = Number(pb[i] ?? 0) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
