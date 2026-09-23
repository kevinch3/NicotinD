/**
 * Wrap an async job so at most one run is in flight and at most one more is
 * queued behind it. A call made while a run is in progress joins the single
 * trailing run instead of starting its own, so a burst of N triggers costs two
 * runs, not N overlapping ones (#1303). The trailing run starts only after the
 * current one settles, so it still observes every change made before the call.
 */
export function coalescedRun(job: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const run = job().finally(() => {
      if (current === run) current = null;
    });
    current = run;
    return run;
  };

  return () => {
    if (!current) return start();
    if (!trailing) {
      trailing = current
        .catch(() => {})
        .then(() => {
          trailing = null;
          return start();
        });
    }
    return trailing;
  };
}
