/**
 * Which of the optional managed servers a run needs, from its `--project` flags (#1906).
 *
 * The onboarding server and the TV-bundle server (plus the TV build itself)
 * exist for one project each, but Playwright starts every `webServer` for every
 * run. On a 3 GB machine a `--project=chromium` subset paid for two servers and
 * a second production build it never touched. With no `--project` at all the
 * run is the whole suite, and everything starts as before.
 */
export interface ServerNeeds {
  onboarding: boolean;
  tv: boolean;
}

export function selectedProjects(argv: readonly string[]): string[] {
  const names: string[] = [];
  argv.forEach((arg, i) => {
    if (arg.startsWith('--project=')) names.push(arg.slice('--project='.length));
    else if (arg === '--project' && argv[i + 1]) names.push(argv[i + 1]!);
  });
  return names;
}

export function serverNeeds(argv: readonly string[]): ServerNeeds {
  const projects = selectedProjects(argv);
  if (projects.length === 0) return { onboarding: true, tv: true };
  return {
    onboarding: projects.includes('onboarding'),
    tv: projects.some((p) => p === 'tv' || p === 'tv-setup'),
  };
}
