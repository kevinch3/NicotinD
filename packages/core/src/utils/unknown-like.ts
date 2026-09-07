/**
 * Is this tag value a placeholder rather than a fact?
 *
 * Sources write "Unknown" where they mean "I have no idea", and it has to be
 * read as *absent* — a literal `Unknown` treated as a name mints an artist,
 * an album or a folder called Unknown, which is how a shared `<Artist>/Unknown/`
 * bucket comes to exist at all.
 *
 * Lives in core because both sides of the pipeline need it and they cannot
 * share the reader's copy: the scanner asks it of on-disk tags, and the
 * acquisition lane asks it of addon-reported metadata before that metadata ever
 * becomes filing information (issue #997).
 */
export function isUnknownLike(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value
    .toLowerCase()
    .replace(/[\[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    normalized === '' ||
    normalized === 'unknown' ||
    normalized === 'unknown artist' ||
    normalized === 'unknown album' ||
    normalized === 'unknown title'
  );
}
