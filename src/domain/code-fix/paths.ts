// Code fixer path rules (spec 009, decisions 5 and 10): a small glob matcher, the built-in denied paths and safe
// repo-relative paths. Pure: no node imports (`path.matchesGlob` is not allowed in the domain).

/** Paths the fixer never reads as an anchor or edits. Config `deniedPaths` only adds to this list. */
export const BUILT_IN_DENIED: readonly string[] = Object.freeze([
  ".github/**", ".gitlab-ci.yml", ".circleci/**", "**/migrations/**", "**/migrate/**", "**/*.sql", "infra/**",
  "terraform/**", "**/*.tf", "deploy/**", "k8s/**", "helm/**", "**/Dockerfile*", "**/docker-compose*", "**/auth/**",
  "**/security/**", "**/crypto/**", "**/session*", "**/permission*", "**/payment*", "**/billing/**", "**/secret*",
  "**/.env*", "**/*.pem", "**/*.key", "**/.*rc*", "**/*.config.*", "package.json", "package-lock.json",
  "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "tsconfig*.json", ".npmrc", ".nvmrc", "AGENTS.md",
  "CONTRIBUTING.md", "CODEOWNERS", "**/vendor/**", "**/node_modules/**", "dist/**", "build/**",
]);

const REGEX_META = /[.+^$()|[\]\\]/;

/**
 * Glob to an anchored RegExp. `*` matches within one segment, `?` one character of a segment, `**` any number of
 * segments (including none: `a/**\/b` matches `a/b`, `a/**` matches `a`), `{a,b}` alternatives (may nest). Every other
 * character is literal. A `}` or `,` outside braces is literal; an unclosed `{` is literal.
 */
export function globToRegExp(glob: string, options: { nocase?: boolean } = {}): RegExp {
  return new RegExp(`^${globSource(glob)}$`, options.nocase ? "i" : "");
}

function globSource(glob: string): string {
  const closes = matchBraces(glob);
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const next = glob[i + 2];
        if (atStart && next === "/") {
          out += "(?:[^/]*/)*"; // `**/`: zero or more whole segments
          i += 2;
          continue;
        }
        if (atStart && next === undefined && i > 0) {
          out = out.slice(0, -1) + "(?:/.*)?"; // `/**` at the end: the directory itself or anything below it
          i += 1;
          continue;
        }
        out += ".*";
        i += 1;
        continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{" && closes.has(i)) {
      out += "(?:";
      depth++;
    } else if (c === "}" && depth > 0 && isClose(closes, i)) {
      out += ")";
      depth--;
    } else if (c === "," && depth > 0) {
      out += "|";
    } else {
      out += REGEX_META.test(c) ? `\\${c}` : c;
    }
  }
  return out;
}

/** Indexes of `{` that have a matching `}`, mapped to it. */
function matchBraces(glob: string): Map<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "{") stack.push(i);
    else if (glob[i] === "}" && stack.length > 0) pairs.set(stack.pop()!, i);
  }
  return pairs;
}

function isClose(pairs: Map<number, number>, i: number): boolean {
  for (const close of pairs.values()) if (close === i) return true;
  return false;
}

export function matchesAnyGlob(path: string, globs: readonly string[], options: { nocase?: boolean } = {}): boolean {
  return globs.some((g) => g.length > 0 && globToRegExp(g, options).test(path));
}

/** The built-in list plus the config's additions (never fewer than the built-ins). */
export function deniedPatterns(extra: readonly string[] = []): string[] {
  return [...BUILT_IN_DENIED, ...extra.filter((p) => p.length > 0 && !BUILT_IN_DENIED.includes(p))];
}

/**
 * Whether a repo path is denied by `BUILT_IN_DENIED` or `extra`. Fail-closed by construction: an unsafe path is denied,
 * matching ignores case, a pattern without `/` matches a name at any depth, and a pattern that matches an ancestor
 * directory denies everything below it. `extra` only adds patterns: there is no negation.
 */
export function isDenied(path: string, extra: readonly string[] = []): boolean {
  const safe = toSafeRelPath(path);
  if (safe === null) return true;
  const regexes = deniedPatterns(extra).map((p) => globToRegExp(p.includes("/") ? p : `**/${p}`, { nocase: true }));
  const segments = safe.split("/");
  for (let n = 1; n <= segments.length; n++) {
    const candidate = segments.slice(0, n).join("/");
    if (regexes.some((re) => re.test(candidate))) return true;
  }
  return false;
}

/**
 * A repo-relative POSIX path, or null. Rejects an empty path, `..`, `.` or empty segments (a leading `./` is
 * dropped), an absolute or Windows path, a backslash, `:`, NUL or any control character, `~`, and a trailing `/`.
 */
export function toSafeRelPath(path: string): string | null {
  if (typeof path !== "string") return null;
  let p = path;
  while (p.startsWith("./")) p = p.slice(2);
  if (p.length === 0 || p.length > 300) return null;
  if (/[\u0000-\u001f\u007f\\:~]/.test(p)) return null;
  if (p.startsWith("/")) return null;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}
