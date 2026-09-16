/**
 * Glob matching for the indexer's include/exclude lists.
 *
 * ## Why not a package
 *
 * The whole need is "does this vault path match `**\/*.md`", asked once per file
 * during a scan. A glob library would arrive with options, negation and brace
 * expansion that this project does not use, and -- more importantly -- with a
 * different idea of what `*` does than the one the settings page promises. A
 * hundred lines with tests pins the semantics where the user can read them.
 *
 * ## The two rules that must be explicit
 *
 * 1. **`*` does not cross `/`, `**` does.** That is the whole point of having
 *    both; `*.md` matching `notes/deep/a.md` is the surprise that makes an
 *    exclude list silently useless.
 * 2. **Exclude wins over include.** A user who writes `**\/*.md` and
 *    `.obsidian/**` means "notes, not configuration", and evaluating include
 *    first would index the configuration directory every time.
 *
 * Pure: no I/O, no Obsidian, no case folding of the vault.
 */

/** Vault paths use `/`, never `\`; `./` and doubled slashes are noise. */
export function normalizeVaultPath(path: string): string {
  const text = (path ?? "").replace(/\\/g, "/").trim();
  const withoutLeading = text.replace(/^\.?\/*/, "");
  const collapsed = withoutLeading.replace(/\/{2,}/g, "/");
  return collapsed.replace(/\/+$/, "");
}

/**
 * One glob pattern as an anchored regular expression.
 *
 * Character classes (`[abc]`) are deliberately literal: supporting them means
 * supporting escaping inside them, and a user who writes `[` in a filename is
 * not asking for a character class. Everything else is escaped, so a pattern is
 * never accidentally a regexp.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = normalizeVaultPath(pattern);
  let out = "^";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      const double = source[index + 1] === "*";
      if (double) {
        index += 1;
        // `**/` means "this directory or any depth below it", so the slash is
        // part of the token: `**/*.md` must match both `a.md` and `notes/a.md`.
        if (source[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

/** Does `path` match one pattern? Paths and patterns are normalized first. */
export function matchGlob(pattern: string, path: string, options: { caseInsensitive?: boolean } = {}): boolean {
  const target = normalizeVaultPath(path);
  if (!target) return false;
  const regexp = globToRegExp(pattern);
  if (regexp.test(target)) return true;
  if (options.caseInsensitive) return globToRegExp(pattern.toLowerCase()).test(target.toLowerCase());
  return false;
}

export interface AiGlobFilter {
  /** Empty means "everything". */
  include?: readonly string[];
  exclude?: readonly string[];
}

/**
 * Is this path in the indexer's working set?
 *
 * The order is documented above: include first (or everything when the list is
 * empty), then exclude. An empty exclude list is the common case and costs one
 * array check.
 */
export function isPathIncluded(path: string, filter: AiGlobFilter): boolean {
  const target = normalizeVaultPath(path);
  if (!target) return false;
  const included = !filter.include?.length || filter.include.some((pattern) => matchGlob(pattern, target));
  if (!included) return false;
  return !filter.exclude?.some((pattern) => matchGlob(pattern, target));
}

/**
 * The directories a scan should skip before it even looks at a file.
 *
 * Returned as patterns so the same matcher serves here and in the settings
 * preview; the point is that `.obsidian` is not a note and its plugin data is
 * both private and noisy.
 */
export const DEFAULT_INDEX_EXCLUDES: readonly string[] = [".obsidian/**", ".trash/**", "**/.DS_Store"];