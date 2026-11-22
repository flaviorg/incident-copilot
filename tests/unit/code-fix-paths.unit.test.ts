import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_DENIED, deniedPatterns, globToRegExp, isDenied, matchesAnyGlob, toSafeRelPath } from "../../src/domain/code-fix/paths.ts";
import { CODE_FIX_CEILINGS, CODE_FIX_DEFAULT_LIMITS, effectiveLimits } from "../../src/domain/code-fix/limits.ts";

// ---------- glob semantics ----------

test("globToRegExp: * stays inside one segment", () => {
  const re = globToRegExp("src/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(!re.test("src/x/a.ts"));
  assert.ok(!re.test("lib/a.ts"));
});

test("globToRegExp: ** spans zero or more segments", () => {
  const re = globToRegExp("src/**/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(re.test("src/x/a.ts"));
  assert.ok(re.test("src/x/y/z/a.ts"));
  assert.ok(!re.test("lib/src/a.ts"));
  const tail = globToRegExp("dist/**");
  assert.ok(tail.test("dist/a.js"));
  assert.ok(tail.test("dist/a/b.js"));
  assert.ok(tail.test("dist"));
  assert.ok(!tail.test("distro/a.js"));
  const lead = globToRegExp("**/migrations/**");
  assert.ok(lead.test("migrations/001.js"));
  assert.ok(lead.test("db/migrations/001.js"));
  assert.ok(!lead.test("db/migrationsx/001.js"));
});

test("globToRegExp: {a,b} alternatives", () => {
  const re = globToRegExp("src/**/*.{js,ts}");
  assert.ok(re.test("src/a.js"));
  assert.ok(re.test("src/b/a.ts"));
  assert.ok(!re.test("src/a.mjs"));
  assert.ok(!re.test("src/a.jsx"));
  const t = globToRegExp("tests/**/*.test.{js,ts}");
  assert.ok(t.test("tests/cart.test.ts"));
  assert.ok(!t.test("tests/cart.ts"));
});

test("globToRegExp: regex metacharacters are literal", () => {
  const re = globToRegExp("a+b.(c)$.js");
  assert.ok(re.test("a+b.(c)$.js"));
  assert.ok(!re.test("aab.(c)$.js"));
  assert.ok(!globToRegExp("a.js").test("abjs"));
});

test("matchesAnyGlob", () => {
  assert.ok(matchesAnyGlob("src/a.ts", ["lib/**", "src/**/*.ts"]));
  assert.ok(!matchesAnyGlob("src/a.ts", []));
});

// ---------- denied paths ----------

const DENIED_SAMPLES: ReadonlyArray<[pattern: string, path: string]> = [
  [".github/**", ".github/workflows/ci.yml"],
  [".gitlab-ci.yml", ".gitlab-ci.yml"],
  [".circleci/**", ".circleci/config.yml"],
  ["**/migrations/**", "src/db/migrations/001_init.js"],
  ["**/migrate/**", "src/migrate/run.ts"],
  ["**/*.sql", "src/db/schema.sql"],
  ["infra/**", "infra/main.js"],
  ["terraform/**", "terraform/vpc.js"],
  ["**/*.tf", "ops/main.tf"],
  ["deploy/**", "deploy/run.js"],
  ["k8s/**", "k8s/app.yaml"],
  ["helm/**", "helm/values.yaml"],
  ["**/Dockerfile*", "services/api/Dockerfile.prod"],
  ["**/docker-compose*", "docker-compose.yml"],
  ["**/auth/**", "src/auth/login.ts"],
  ["**/security/**", "src/security/csp.ts"],
  ["**/crypto/**", "src/crypto/hash.js"],
  ["**/session*", "src/session.ts"],
  ["**/permission*", "src/permissions.ts"],
  ["**/payment*", "src/payment-client.js"],
  ["**/billing/**", "src/billing/invoice.ts"],
  ["**/secret*", "src/secrets.ts"],
  ["**/.env*", "config/.env.production"],
  ["**/*.pem", "certs/server.pem"],
  ["**/*.key", "certs/server.key"],
  ["**/.*rc*", "src/.eslintrc.cjs"],
  ["**/*.config.*", "vite.config.ts"],
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["npm-shrinkwrap.json", "npm-shrinkwrap.json"],
  ["yarn.lock", "yarn.lock"],
  ["pnpm-lock.yaml", "pnpm-lock.yaml"],
  ["bun.lockb", "bun.lockb"],
  ["tsconfig*.json", "tsconfig.build.json"],
  [".npmrc", ".npmrc"],
  [".nvmrc", ".nvmrc"],
  ["AGENTS.md", "AGENTS.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.md"],
  ["CODEOWNERS", "CODEOWNERS"],
  ["**/vendor/**", "src/vendor/lib.js"],
  ["**/node_modules/**", "node_modules/x/index.js"],
  ["dist/**", "dist/index.js"],
  ["build/**", "build/index.js"],
];

test("every BUILT_IN_DENIED entry is covered by a sample", () => {
  assert.deepEqual([...BUILT_IN_DENIED].sort(), DENIED_SAMPLES.map(([p]) => p).sort());
});

for (const [pattern, path] of DENIED_SAMPLES) {
  test(`isDenied: ${pattern} denies ${path}`, () => {
    assert.ok(globToRegExp(pattern).test(path), `${pattern} itself matches`);
    assert.equal(isDenied(path, []), true);
  });
}

test("isDenied: a denied directory denies everything below it", () => {
  assert.equal(isDenied("src/sessions/store.ts", []), true);
  assert.equal(isDenied("src/payments/charge.ts", []), true);
});

test("isDenied: bare-name patterns match at any depth and case-insensitively", () => {
  assert.equal(isDenied("packages/api/package.json", []), true);
  assert.equal(isDenied("services/api/dockerfile", []), true);
  assert.equal(isDenied("SRC/AUTH/login.ts", []), true);
});

test("isDenied: ordinary source files are allowed", () => {
  for (const p of ["src/cart.ts", "src/lib/price.js", "src/routes/orders.mjs", "tests/cart.test.ts"]) {
    assert.equal(isDenied(p, []), false, p);
  }
});

test("config deniedPaths only adds entries", () => {
  assert.equal(isDenied("src/pricing/total.ts", []), false);
  assert.equal(isDenied("src/pricing/total.ts", ["src/pricing/**"]), true);
  // A negation or an empty pattern never removes a built-in entry.
  assert.equal(isDenied(".github/workflows/ci.yml", ["!.github/**", "", "!**"]), true);
  assert.equal(isDenied("package.json", ["!package.json"]), true);
  const all = deniedPatterns(["src/pricing/**"]);
  for (const p of BUILT_IN_DENIED) assert.ok(all.includes(p));
  assert.ok(all.includes("src/pricing/**"));
});

test("isDenied: an unsafe path is denied", () => {
  assert.equal(isDenied("../etc/passwd", []), true);
  assert.equal(isDenied("", []), true);
});

// ---------- safe relative paths ----------

test("toSafeRelPath rejects unsafe paths", () => {
  for (const p of [
    "", "..", "../a.ts", "src/../a.ts", "src/..", "/etc/passwd", "/app/src/a.ts", "C:\\src\\a.ts", "C:/src/a.ts",
    "src\\a.ts", "src/a\0.ts", "~/a.ts", "src/~a.ts", "src//a.ts", "src/./a.ts", "src/a.ts/", "app:///src/a.ts", "src/a\n.ts",
  ]) {
    assert.equal(toSafeRelPath(p), null, JSON.stringify(p));
  }
});

test("toSafeRelPath accepts and normalizes repo-relative POSIX paths", () => {
  assert.equal(toSafeRelPath("src/cart.ts"), "src/cart.ts");
  assert.equal(toSafeRelPath("./src/cart.ts"), "src/cart.ts");
  assert.equal(toSafeRelPath("index.js"), "index.js");
  assert.equal(toSafeRelPath("src/a..b.js"), "src/a..b.js");
});

// ---------- limits ----------

test("CODE_FIX_CEILINGS hold the spec values", () => {
  assert.equal(CODE_FIX_CEILINGS.maxFiles, 3);
  assert.equal(CODE_FIX_CEILINGS.maxSourceLines, 20);
  assert.equal(CODE_FIX_CEILINGS.maxTotalLines, 50);
  assert.equal(CODE_FIX_CEILINGS.maxTestLines, 40);
  assert.equal(CODE_FIX_CEILINGS.maxEdits, 2);
  assert.equal(CODE_FIX_CEILINGS.maxAuthorAttempts, 3);
  assert.equal(CODE_FIX_CEILINGS.maxLlmCalls, 8);
  assert.equal(CODE_FIX_CEILINGS.maxConcurrent, 2);
  assert.equal(CODE_FIX_CEILINGS.maxTokens, 200_000);
  assert.ok(Object.isFrozen(CODE_FIX_CEILINGS));
});

test("effectiveLimits: defaults when absent, config can only lower", () => {
  assert.deepEqual(effectiveLimits(undefined), CODE_FIX_DEFAULT_LIMITS);
  assert.equal(CODE_FIX_DEFAULT_LIMITS.maxLlmCalls, 6);
  assert.equal(CODE_FIX_DEFAULT_LIMITS.maxAuthorAttempts, 2);
  const eff = effectiveLimits({ maxFiles: 2, maxSourceLines: 999, maxLlmCalls: 50, maxEdits: 1 });
  assert.equal(eff.maxFiles, 2);
  assert.equal(eff.maxSourceLines, 20);
  assert.equal(eff.maxLlmCalls, 8);
  assert.equal(eff.maxEdits, 1);
  assert.equal(eff.maxTotalLines, CODE_FIX_DEFAULT_LIMITS.maxTotalLines);
  for (const k of Object.keys(CODE_FIX_CEILINGS) as (keyof typeof CODE_FIX_CEILINGS)[]) {
    assert.ok(eff[k] <= CODE_FIX_CEILINGS[k], k);
  }
});

test("effectiveLimits: non-finite values fall back to defaults", () => {
  const eff = effectiveLimits({ maxFiles: Number.NaN, maxEdits: Number.POSITIVE_INFINITY });
  assert.equal(eff.maxFiles, CODE_FIX_DEFAULT_LIMITS.maxFiles);
  assert.equal(eff.maxEdits, CODE_FIX_DEFAULT_LIMITS.maxEdits);
});
