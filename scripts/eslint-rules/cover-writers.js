/**
 * ESLint rule `nicotind/cover-writers`: a raw write to served cover bytes must
 * live in a module that bumps the cover's revision (#1666).
 *
 * WHY: a cover URL is `/api/cover/<id>?v=<rev>`, and the browser caches it for a
 * day by URL. The rev (`cover_rev`) is the only thing that moves the URL when
 * the bytes change, and `bumpCoverRev` (services/cover-rev.ts) is its one
 * writer. The service-layer writers call it — `setArtwork` / `deleteArtwork`,
 * `writeArtistImageOverride` / `deleteArtistImageOverride`, `applyAlbumCover` —
 * so any caller of those is covered by construction. What is not covered is a
 * new code path that writes the bytes *underneath* them: raw SQL into
 * `library_artwork`, a file into the artist-override store, or a direct
 * `replaceFolderCover`. That path serves new bytes under the old URL — the
 * stale-cover bug again, with every test green.
 *
 * So the raw write primitives are allowed only in `OWNERS` (modules that bump)
 * and in `EXEMPT` (modules that only delete the art together with its entity —
 * no URL survives to re-key). Each entry carries its reason.
 *
 * Denominator: `cover-writers.test.ts` lints every listed module's own source
 * under a foreign filename and requires the rule to fire, so an entry whose
 * write shape the rule cannot see — or one that stopped writing — fails a test
 * instead of watching nothing; and it requires every owner to call
 * `bumpCoverRev`.
 */
import { relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

/** Modules that write cover bytes and bump the rev for it. */
export const OWNERS = [
  {
    file: 'packages/api/src/services/artwork-store.ts',
    reason: 'setArtwork / deleteArtwork: the canonical-URL store, bumps on a real change',
  },
  {
    file: 'packages/api/src/services/artist-image-override.ts',
    reason: 'writeArtistImageOverride / deleteArtistImageOverride: the override store, bump',
  },
  {
    file: 'packages/api/src/services/album-cover-mutate.ts',
    reason: 'applyAlbumCover: replaces the folder cover, then bumps once',
  },
  {
    file: 'packages/api/src/services/artist-curation-carry.ts',
    reason: 'carries a portrait or override onto the merge target, then bumps it',
  },
  {
    file: 'packages/api/src/services/metadata-fix.ts',
    reason: 'repointAlbumKeyed moves the artwork row onto the new album id, then bumps it',
  },
];

/** Modules that delete cover art only together with the entity that owned it. */
export const EXEMPT = [
  {
    file: 'packages/api/src/services/library-aggregates.ts',
    reason: 'drops a pruned artist row and its artwork; no artist is left to re-key',
  },
  {
    file: 'packages/api/src/services/library-deletion.ts',
    reason: 'deletes an album and its artwork row together',
  },
  {
    file: 'packages/api/src/scripts/repair-pollution.ts',
    reason: 'deletes a polluted album, its songs and its artwork row together',
  },
];

/** Raw SQL that writes the canonical-artwork table. A read or a JOIN is fine. */
const ARTWORK_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+library_artwork\b/i;

/** The artist-override store's directory name: reaching it is writing past the bump. */
const OVERRIDE_DIR = 'artist-overrides';

/** Writes the folder cover and bumps nothing; `applyAlbumCover` is the door. */
const RAW_CALLEES = new Set(['replaceFolderCover']);

/** @param {import('eslint').Rule.Node} node */
function insideTemplate(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'TemplateLiteral') return true;
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'A raw cover-byte write must live in a module that bumps cover_rev' },
    schema: [],
  },
  create(context) {
    const file = relative(repoRoot, context.filename).replace(/\\/g, '/');
    if ([...OWNERS, ...EXEMPT].some((e) => e.file === file)) return {};
    const sourceCode = context.sourceCode;
    const advice =
      'Go through setArtwork / deleteArtwork, write/deleteArtistImageOverride or ' +
      'applyAlbumCover, which bump cover_rev — or add a reasoned OWNERS/EXEMPT entry in ' +
      'scripts/eslint-rules/cover-writers.js (#1666).';

    /** @param {import('eslint').Rule.Node} node */
    function visitText(node) {
      if (insideTemplate(node)) return;
      const text = sourceCode.getText(node);
      if (ARTWORK_WRITE.test(text)) {
        context.report({
          node,
          message: `Raw write to library_artwork: the cover's URL never moves. ${advice}`,
        });
      } else if (node.type === 'Literal' && node.value === OVERRIDE_DIR) {
        context.report({
          node,
          message: `Reaching the artist-override store directly skips the rev bump. ${advice}`,
        });
      }
    }
    return {
      Literal: (node) => {
        if (typeof node.value === 'string') visitText(node);
      },
      TemplateLiteral: visitText,
      CallExpression: (node) => {
        const callee = node.callee;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
              ? callee.property.name
              : null;
        if (name && RAW_CALLEES.has(name)) {
          context.report({
            node,
            message: `\`${name}\` writes the folder cover and bumps nothing. ${advice}`,
          });
        }
      },
    };
  },
};
