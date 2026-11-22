// Spec 009, decision 7 (AC-65): the pure parts of the process sandbox: argv, environment and report parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectPath } from "../../src/infra/paths.ts";
import {
  SANDBOX_ENV_KEYS,
  SANDBOX_REPORT_PREFIX,
  buildSandboxArgv,
  buildSandboxEnv,
  isSafeTestFileArg,
  parseReport,
} from "../../src/infra/code-fix/sandbox-argv.ts";
import sandboxReporter from "../../src/infra/code-fix/kit/reporter.ts";

const EXEC = "/opt/node/bin/node";
const ATTEMPT = "/tmp/ic-fix-abc123";
const ROOT = `${ATTEMPT}/repo`;

function line(obj: unknown): string {
  return `${SANDBOX_REPORT_PREFIX}${JSON.stringify(obj)}`;
}

function testLine(over: Record<string, unknown> = {}): string {
  return line({ kind: "test", name: "t", file: `${ROOT}/tests/a.test.js`, status: "passed", ...over });
}

const SUMMARY = line({ kind: "summary" });

test("buildSandboxArgv produces exactly the decision 7 argv (one --allow-fs-read flag per path on Node 24.21)", () => {
  const argv = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["tests/**/*.test.js"], network: "best_effort" });
  assert.deepEqual(argv, [
    EXEC,
    "--permission",
    `--allow-fs-read=${ATTEMPT}/repo`,
    `--allow-fs-read=${ATTEMPT}/kit`,
    `--allow-fs-read=${ATTEMPT}/tmp`,
    `--allow-fs-write=${ATTEMPT}/tmp`,
    "--disallow-code-generation-from-strings",
    `--import=${ATTEMPT}/kit/preload.ts`,
    "--test",
    "--test-isolation=none",
    `--test-reporter=${ATTEMPT}/kit/reporter.ts`,
    "--test-reporter-destination=stdout",
    "tests/**/*.test.js",
  ]);
});

test("isolated mode prefixes unshare --user --map-root-user --net --", () => {
  const argv = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["a.test.js"], network: "isolated" });
  assert.deepEqual(argv.slice(0, 6), ["/usr/bin/unshare", "--user", "--map-root-user", "--net", "--", EXEC]);
  const custom = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["a.test.js"], network: "isolated", unsharePath: "/x/unshare" });
  assert.equal(custom[0], "/x/unshare");
  const best = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["a.test.js"], network: "best_effort", unsharePath: "/x/unshare" });
  assert.equal(best[0], EXEC);
});

test("extra imports (test-only) are read-granted and imported before the kit preload, so the preload wins", () => {
  const extra = "/repo/copilot/tests/setup/no-network.ts";
  const argv = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["a.test.js"], network: "best_effort", extraImports: [extra] });
  assert.ok(argv.includes(`--allow-fs-read=${extra}`));
  const iExtra = argv.indexOf(`--import=${extra}`);
  const iPreload = argv.indexOf(`--import=${ATTEMPT}/kit/preload.ts`);
  assert.ok(iExtra > 0 && iPreload > iExtra);
  assert.ok(argv.indexOf("--test") > iPreload);
});

test("the argv never grants child process, worker, addon, WASI, inspector or OpenSSL store rights", () => {
  for (const network of ["isolated", "best_effort"] as const) {
    const argv = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["a.test.js", "b/*.test.ts"], network, extraImports: ["/x/y.ts"] });
    for (const flag of ["--allow-child-process", "--allow-worker", "--allow-addons", "--allow-wasi", "--allow-inspector", "--allow-openssl-store", "--permission-audit"]) {
      assert.ok(!argv.some((a) => a.startsWith(flag)), `${network}: ${flag}`);
    }
    assert.ok(!argv.some((a) => a.startsWith("--allow-fs-write=") && a !== `--allow-fs-write=${ATTEMPT}/tmp`));
    assert.ok(!argv.some((a) => a.includes(",")), "no comma lists: Node 24.21 reads them as one literal path");
  }
});

test("the preload can be left out only on request (the self-test's raw OS phase)", () => {
  const argv = buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["a.test.js"], network: "isolated", preload: false });
  assert.ok(!argv.some((a) => a.startsWith("--import=")));
  assert.ok(argv.includes("--permission"));
});

test("test file arguments must be safe globs: no flag, absolute path, parent segment or odd character", () => {
  for (const ok of ["tests/**/*.test.js", "tests/a.test.{js,ts}", "probe.test.ts", "a-b_c.test.mjs"]) assert.equal(isSafeTestFileArg(ok), true, ok);
  for (const bad of ["", "-r", "--test-only", "/etc/passwd", "../x.test.js", "tests/../../x.js", "a b.js", "a;rm.js", "$(x).js", "a\nb.js", "C:\\x.js", "tests/"]) {
    assert.equal(isSafeTestFileArg(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: ["--inspect"], network: "best_effort" }));
  assert.throws(() => buildSandboxArgv({ execPath: EXEC, attemptDir: ATTEMPT, files: [], network: "best_effort" }));
});

test("buildSandboxEnv holds only the allowlisted keys even when the parent holds copilot secrets", () => {
  const planted = ["GITHUB_FIX_TOKEN", "OPENROUTER_API_KEY", "APPROVAL_TOKEN", "API_TOKEN"] as const;
  const before = Object.fromEntries(planted.map((k) => [k, process.env[k]]));
  const value = "sk-or-v1-" + "a".repeat(40);
  try {
    for (const k of planted) process.env[k] = value;
    const env = buildSandboxEnv({ execPath: EXEC, attemptDir: ATTEMPT });
    assert.deepEqual(Object.keys(env).sort(), [...SANDBOX_ENV_KEYS].sort());
    assert.deepEqual(env, {
      PATH: "/opt/node/bin:/usr/bin:/bin",
      HOME: `${ATTEMPT}/tmp`,
      TMPDIR: `${ATTEMPT}/tmp`,
      CI: "1",
      NODE_ENV: "test",
      LANG: "C.UTF-8",
      TZ: "UTC",
      NO_COLOR: "1",
    });
    assert.ok(!Object.values(env).includes(value));
  } finally {
    for (const k of planted) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});

test("parseReport reads only prefixed NDJSON lines and summarizes a failing run", () => {
  const stdout = [
    "noise before",
    testLine({ name: "sums", status: "passed" }),
    `${SANDBOX_REPORT_PREFIX}{not json`,
    `  ${SANDBOX_REPORT_PREFIX}${JSON.stringify({ kind: "test", name: "forged-indent", status: "failed" })}`,
    testLine({
      name: "missing price",
      status: "failed",
      errorName: "TypeError",
      message: "Cannot read properties of undefined (reading 'amount')",
      frames: [
        { file: `${ROOT}/src/cart.js`, line: 2 },
        { file: "node:internal/test_runner/test", line: 10 },
        { file: `${ROOT}/tests/a.test.js`, line: 5 },
      ],
    }),
    testLine({ name: "s", status: "skipped" }),
    testLine({ name: "t", status: "todo" }),
    "console.log from a test",
    SUMMARY,
  ].join("\n");
  const s = parseReport(stdout, 1, { repoRoot: ROOT, durationMs: 42 });
  assert.equal(s.outcome, "failed");
  assert.equal(s.exitCode, 1);
  assert.deepEqual([s.total, s.passed, s.failed, s.skipped, s.todo, s.cancelled], [4, 1, 1, 1, 1, 0]);
  assert.equal(s.durationMs, 42);
  assert.deepEqual(s.failures, [
    {
      name: "missing price",
      file: "tests/a.test.js",
      errorName: "TypeError",
      message: "Cannot read properties of undefined (reading 'amount')",
      frames: [{ file: "src/cart.js", line: 2 }, { file: "tests/a.test.js", line: 5 }],
    },
  ]);
});

test("parseReport: a clean run with exit 0 is passed", () => {
  const s = parseReport([testLine(), testLine({ name: "u" }), SUMMARY].join("\n"), 0, { repoRoot: ROOT });
  assert.equal(s.outcome, "passed");
  assert.deepEqual([s.total, s.passed, s.failed], [2, 2, 0]);
  assert.deepEqual(s.failures, []);
});

test("parseReport: an empty report, zero tests, or a report that contradicts the exit code is error", () => {
  const cases: [string, string, number | null][] = [
    ["empty stdout", "", 0],
    ["noise only", "hello\nworld", 0],
    ["tests but no summary line", testLine(), 0],
    ["zero tests", SUMMARY, 0],
    ["exit 0 with a failure", [testLine({ status: "failed" }), SUMMARY].join("\n"), 0],
    ["exit non-zero with no failure", [testLine(), SUMMARY].join("\n"), 1],
    ["killed by a signal", [testLine(), SUMMARY].join("\n"), null],
    ["two summary lines", [testLine(), SUMMARY, SUMMARY].join("\n"), 0],
  ];
  for (const [label, stdout, code] of cases) {
    assert.equal(parseReport(stdout, code, { repoRoot: ROOT }).outcome, "error", label);
  }
});

test("parseReport: a cancelled or timed-out test counts as cancelled and agrees with a non-zero exit", () => {
  const s = parseReport([testLine(), testLine({ name: "slow", status: "cancelled", errorName: "TestTimeoutFailure", message: "timed out" }), SUMMARY].join("\n"), 1, { repoRoot: ROOT });
  assert.equal(s.outcome, "failed");
  assert.equal(s.cancelled, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.failures[0]?.errorName, "TestTimeoutFailure");
});

test("parseReport strips the work-tree root, keeps at most 10 repo frames and clips message, name and errorName", () => {
  const frames = Array.from({ length: 15 }, (_, i) => ({ file: `${ROOT}/src/f${i}.js`, line: i + 1 }));
  const s = parseReport(
    [testLine({ name: "n".repeat(500), status: "failed", errorName: "E".repeat(300), message: "m".repeat(1000), frames }), SUMMARY].join("\n"),
    1,
    { repoRoot: ROOT },
  );
  const f = s.failures[0]!;
  assert.equal(f.frames.length, 10);
  assert.deepEqual(f.frames[0], { file: "src/f0.js", line: 1 });
  assert.ok(f.frames.every((fr) => !fr.file.startsWith("/")));
  assert.ok(f.message.length <= 200);
  assert.ok(f.name.length <= 200);
  assert.ok(f.errorName.length <= 120);
});

test("parseReport drops frames outside the work tree, including a sibling that shares the root prefix", () => {
  const s = parseReport(
    [testLine({ status: "failed", errorName: "TypeError", message: "x", frames: [
      { file: `${ROOT}-evil/src/a.js`, line: 1 },
      { file: "/etc/passwd", line: 1 },
      { file: `${ROOT}/../kit/preload.ts`, line: 3 },
      { file: `${ROOT}/src/b.js`, line: 0 },
      { file: `${ROOT}/src/c.js`, line: 7 },
    ] }), SUMMARY].join("\n"),
    1,
    { repoRoot: ROOT },
  );
  assert.deepEqual(s.failures[0]?.frames, [{ file: "src/c.js", line: 7 }]);
});

test("parseReport keeps at most 5 failures while counting all of them", () => {
  const lines = Array.from({ length: 8 }, (_, i) => testLine({ name: `f${i}`, status: "failed", errorName: "Error", message: "x" }));
  const s = parseReport([...lines, SUMMARY].join("\n"), 1, { repoRoot: ROOT });
  assert.equal(s.failed, 8);
  assert.equal(s.failures.length, 5);
});

test("parseReport ignores records of unknown shape and status", () => {
  const s = parseReport([testLine(), line({ kind: "test", name: "x", status: "weird" }), line({ kind: "other" }), line([1, 2]), SUMMARY].join("\n"), 0, { repoRoot: ROOT });
  assert.equal(s.outcome, "passed");
  assert.equal(s.total, 1);
});

// ---------- the kit reporter (pure over its event stream) ----------


async function report(events: { type: string; data?: unknown }[]): Promise<string> {
  async function* source() {
    for (const e of events) yield e;
  }
  let out = "";
  for await (const chunk of sandboxReporter(source())) out += chunk;
  return out;
}

const FILE = `${ROOT}/tests/a.test.js`;
const testFailure = (cause: unknown) => ({ code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause });

test("the kit reporter writes one prefixed line per test, skips suites, and ends with one summary line", async () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'amount')",
    `    at total (file://${ROOT}/src/cart.js:2:41)`,
    "    at Array.reduce (<anonymous>)",
    `    at TestContext.<anonymous> (file://${FILE}:5:22)`,
    "    at Test.runInAsyncScope (node:async_hooks:227:14)",
    `    at ${ROOT}/src/plain.js:9:1`,
  ].join("\n");
  const out = await report([
    { type: "test:start", data: { name: "ignored" } },
    { type: "test:pass", data: { name: "ok", file: FILE, details: { type: "test" } } },
    { type: "test:pass", data: { name: "s", file: FILE, skip: true, details: { type: "test" } } },
    { type: "test:pass", data: { name: "t", file: FILE, todo: "later", details: { type: "test" } } },
    { type: "test:pass", data: { name: "a suite", file: FILE, details: { type: "suite" } } },
    { type: "test:fail", data: { name: "bad", file: FILE, details: { type: "test", error: testFailure({ name: "TypeError", message: "Cannot read properties of undefined (reading 'amount')", stack }) } } },
    { type: "test:fail", data: { name: "slow", file: FILE, details: { type: "test", error: { code: "ERR_TEST_FAILURE", failureType: "testTimeoutFailure", message: "test timed out after 50ms" } } } },
    { type: "test:fail", data: { name: "tests/m.test.js", file: FILE, details: { type: "test", error: { name: "Error", code: "ERR_MODULE_NOT_FOUND", message: "Cannot find module" } } } },
    { type: "test:diagnostic", data: { message: "x" } },
  ]);
  const lines = out.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.every((l) => l.startsWith(SANDBOX_REPORT_PREFIX)));
  const recs = lines.map((l) => JSON.parse(l.slice(SANDBOX_REPORT_PREFIX.length)) as Record<string, unknown>);
  assert.deepEqual(recs.map((r) => [r.kind, r.name, r.status]), [
    ["test", "ok", "passed"],
    ["test", "s", "skipped"],
    ["test", "t", "todo"],
    ["test", "bad", "failed"],
    ["test", "slow", "cancelled"],
    ["test", "tests/m.test.js", "failed"],
    ["summary", undefined, undefined],
  ]);
  assert.deepEqual(recs[3], {
    kind: "test", name: "bad", file: FILE, status: "failed", errorName: "TypeError",
    message: "Cannot read properties of undefined (reading 'amount')",
    frames: [{ file: `${ROOT}/src/cart.js`, line: 2 }, { file: FILE, line: 5 }, { file: `${ROOT}/src/plain.js`, line: 9 }],
  });
  assert.equal(recs[4]?.errorName, "TestTimeoutFailure");
  assert.equal(recs[5]?.errorName, "ERR_MODULE_NOT_FOUND", "a plain Error is named by its Node code");

  const s = parseReport(out, 1, { repoRoot: ROOT });
  assert.equal(s.outcome, "failed");
  assert.deepEqual([s.total, s.passed, s.failed, s.skipped, s.todo, s.cancelled], [6, 1, 2, 1, 1, 1]);
  assert.deepEqual(s.failures[0]?.frames, [{ file: "src/cart.js", line: 2 }, { file: "tests/a.test.js", line: 5 }, { file: "src/plain.js", line: 9 }]);
});

test("the kit reporter's prefix equals SANDBOX_REPORT_PREFIX, and an empty stream is still an error report", async () => {
  const out = await report([]);
  assert.equal(out, `${SANDBOX_REPORT_PREFIX}{"kind":"summary"}\n`);
  assert.equal(parseReport(out, 0, { repoRoot: ROOT }).outcome, "error");
});

test("the kit reporter handles a non-error thrown value and an assertion stack whose message spans lines", async () => {
  const assertion = testFailure({ name: "AssertionError", code: "ERR_ASSERTION", message: "Expected\n\n1 !== 2\n", stack: `AssertionError [ERR_ASSERTION]: Expected\n\n1 !== 2\n\n    at TestContext.<anonymous> (file://${FILE}:7:10)` });
  const out = await report([
    { type: "test:fail", data: { name: "assert", file: FILE, details: { error: assertion } } },
    { type: "test:fail", data: { name: "string", file: FILE, details: { error: testFailure("just a string") } } },
  ]);
  const recs = out.trim().split("\n").map((l) => JSON.parse(l.slice(SANDBOX_REPORT_PREFIX.length)) as Record<string, unknown>);
  assert.equal(recs[0]?.errorName, "AssertionError");
  assert.deepEqual(recs[0]?.frames, [{ file: FILE, line: 7 }]);
  assert.equal(recs[1]?.errorName, "NonErrorThrown");
  assert.equal(recs[1]?.status, "failed");
});

test("the kit files are self-contained: they import only node:* modules", () => {
  for (const f of ["preload.ts", "reporter.ts", "probe.test.ts"]) {
    const text = readFileSync(projectPath("src/infra/code-fix/kit", f), "utf8");
    const specifiers = [...text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);
    assert.ok(specifiers.length > 0, f);
    for (const s of specifiers) assert.ok(s.startsWith("node:"), `${f} imports ${s}`);
  }
});
