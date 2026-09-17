/**
 * The Android application id for a build.
 *
 * Phone and TV are **separate apps**, not two flavours of one. They used to
 * share `ar.kevinroberts.nicotind`, which meant installing the TV APK over the
 * phone one silently swapped the UI — the manual said as much — and it made two
 * F-Droid entries impossible, since F-Droid requires a distinct application id
 * per entry.
 *
 * Since #1168 the suffix applies to **every** channel rather than only the
 * F-Droid build, because there is one TV APK now and an id cannot vary by where
 * it was downloaded from. That is a one-time migration for anyone who
 * sideloaded a TV APK before 0.7.x: the suffixed build installs alongside the
 * old one instead of upgrading it, so the stale copy has to be removed by hand.
 * The alternative was keeping phone and TV on one id and giving up the separate
 * TV listing.
 */
export function androidAppId(baseId: string, tv: boolean): string {
  return tv ? `${baseId}.tv` : baseId;
}
