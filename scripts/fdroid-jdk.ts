/**
 * The JDK deploy.yml's `actions/setup-java` step installs for the release APK,
 * or undefined when the step cannot be read. `check:fdroid` compares it to the
 * JDK fdroiddata builds on (docs/fdroid.md).
 *
 * Tolerates a commit-SHA pin with its `# vX` comment (the shape Renovate's
 * `helpers:pinGitHubActionDigests` writes), hyphenated keys such as
 * `java-package:` before `java-version`, and either quote style — a pin bump
 * must not read as "JDK unknown" and redden an unrelated PR.
 */
export function releaseJdk(deployYml: string): string | undefined {
  return /setup-java@[^\s#]+(?:[ \t]*#[^\n]*)?\s*\n\s*with:\s*\n(?:\s*[\w-]+:.*\n)*?\s*java-version:\s*['"]?([^'"\s]+)['"]?/.exec(
    deployYml,
  )?.[1];
}
