// Spec 009, decision 7 (AC-65, AC-66, AC-79): the process sandbox with a real child on a temporary repository.
// Network is `best_effort` here (no unshare on macOS or in CI) with the no-network setup as a test-only extra import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPath } from "../../src/infra/paths.ts";
import { REDACTED } from "../../src/infra/redact.ts";
import { ProcessSandboxRunner } from "../../src/infra/code-fix/process-sandbox.ts";
import { RUNTIME_ADDED_ENV_KEYS, SANDBOX_ENV_KEYS } from "../../src/infra/code-fix/sandbox-argv.ts";
import { SELF_TEST_CHECKS, runSandboxSelfTest } from "../../src/infra/code-fix/sandbox-self-test.ts";

const NO_NETWORK = projectPath("tests/setup/no-network.ts");

type Attempt = { base: string; attemptDir: string; repo: string; tmp: string; planted: string };

async function makeAttempt(extraFiles: Record<string, string> = {}): Promise<Attempt> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "ic-sbx-"));
  const attemptDir = join(base, "attempt");
  const repo = join(attemptDir, "repo");
  const tmp = join(attemptDir, "tmp");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await mkdir(tmp, { recursive: true });
  // Stands in for copilot.yaml: a sibling of the attempt directory, outside every read grant.
  const planted = join(base, "copilot.yaml");
  await writeFile(planted, "approvalToken: planted\n");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "tiny", type: "module" }),
    "src/cart.js": "export function total(items) {\n  return items.reduce((s, i) => s + i.price.amount, 0);\n}\n",
    "tests/cart.test.js": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { total } from "../src/cart.js";',
      'test("sums prices", () => { assert.equal(total([{ price: { amount: 2 } }]), 2); });',
      'test("tolerates a missing price", () => { assert.equal(total([{}]), 0); });',
      "",
    ].join("\n"),
    ...extraFiles,
  };
  for (const [rel, text] of Object.entries(files)) await writeFile(join(repo, rel), text);
  return { base, attemptDir, repo, tmp, planted };
}

function runner(a: Attempt, over: Partial<ConstructorParameters<typeof ProcessSandboxRunner>[0]> = {}): ProcessSandboxRunner {
  return new ProcessSandboxRunner({ attemptDir: a.attemptDir, network: "best_effort", maxOutputBytes: 65_536, secrets: [], extraImports: [NO_NETWORK], ...over });
}

const signal = () => new AbortController().signal;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a passing and a failing test are summarized from the reporter, with repo-relative frames", async () => {
  const a = await makeAttempt();
  try {
    const r = await runner(a).run({ files: ["tests/cart.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "failed", r.outputTail);
    assert.equal(r.exitCode, 1);
    assert.deepEqual([r.total, r.passed, r.failed, r.skipped, r.todo, r.cancelled], [2, 1, 1, 0, 0, 0]);
    const f = r.failures[0]!;
    assert.equal(f.name, "tolerates a missing price");
    assert.equal(f.file, "tests/cart.test.js");
    assert.equal(f.errorName, "TypeError");
    assert.match(f.message, /amount/);
    assert.deepEqual(f.frames[0], { file: "src/cart.js", line: 2 });
    assert.ok(f.frames.some((fr) => fr.file === "tests/cart.test.js" && fr.line === 5));
    assert.ok(existsSync(join(a.attemptDir, "kit", "preload.ts")) && existsSync(join(a.attemptDir, "kit", "reporter.ts")));
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("a glob argument runs every match; zero matches is an error, never passed", async () => {
  const a = await makeAttempt({ "tests/ok.test.js": 'import { test } from "node:test";\ntest("ok", () => {});\n' });
  try {
    const all = await runner(a).run({ files: ["tests/**/*.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(all.total, 3);
    const none = await runner(a).run({ files: ["nothing/**/*.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(none.outcome, "error");
    assert.equal(none.total, 0);
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("the child sees only the allowlisted environment, never a planted secret", async () => {
  const planted = { GITHUB_FIX_TOKEN: "ghp_" + "b".repeat(36), OPENROUTER_API_KEY: "sk-or-v1-" + "a".repeat(40), APPROVAL_TOKEN: "appr-" + "c".repeat(30), API_TOKEN: "api-" + "d".repeat(30) };
  const before = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  const a = await makeAttempt({
    "tests/env.test.js": [
      'import { test } from "node:test";',
      'test("env", () => { console.log("ENV-KEYS " + Object.keys(process.env).sort().join(",")); console.log("ENV-VALUES " + JSON.stringify(Object.values(process.env))); });',
      "",
    ].join("\n"),
  });
  try {
    Object.assign(process.env, planted);
    const r = await runner(a).run({ files: ["tests/env.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "passed", r.outputTail);
    const keys = /ENV-KEYS (.*)/.exec(r.outputTail)?.[1]?.split(",") ?? [];
    // Node's test runner and macOS add their own keys at start; nothing else may appear.
    const seen = keys.filter((k) => !(RUNTIME_ADDED_ENV_KEYS as readonly string[]).includes(k));
    assert.deepEqual(seen, [...SANDBOX_ENV_KEYS].sort());
    for (const k of Object.keys(planted)) assert.ok(!keys.includes(k), k);
    for (const v of Object.values(planted)) assert.ok(!r.outputTail.includes(v));
    assert.ok(!r.outputTail.includes(REDACTED), "absent, not merely redacted");
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(a.base, { recursive: true, force: true });
  }
});

test("child_process, workers, writes outside tmp/ and reads outside the grants are denied; tmp/ is writable", async () => {
  const a = await makeAttempt();
  const outsideWrite = join(a.base, "escaped.txt");
  await writeFile(join(a.repo, "tests/deny.test.js"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    'const denied = (e) => e && e.code === "ERR_ACCESS_DENIED";',
    'test("child_process import", async () => { await assert.rejects(import("node:child_process"), denied); });',
    'test("child_process via getBuiltinModule", () => { assert.throws(() => process.getBuiltinModule("node:child_process"), denied); });',
    'test("worker", async () => { const { Worker } = await import("node:worker_threads"); assert.throws(() => new Worker("./x.js"), denied); });',
    `test("write outside tmp", () => { assert.throws(() => fs.writeFileSync(${JSON.stringify(outsideWrite)}, "x"), denied); });`,
    `test("write in the work tree", () => { assert.throws(() => fs.writeFileSync(${JSON.stringify(join(a.repo, "src/new.js"))}, "x"), denied); });`,
    `test("read a planted sibling file", () => { assert.throws(() => fs.readFileSync(${JSON.stringify(a.planted)}, "utf8"), denied); });`,
    `test("read the copilot source", () => { assert.throws(() => fs.readFileSync(${JSON.stringify(projectPath("package.json"))}, "utf8"), denied); });`,
    'test("write in tmp", () => { fs.writeFileSync(process.env.TMPDIR + "/ok.txt", "ok"); });',
    'test("eval is disabled", () => { assert.throws(() => new Function("return 1"), EvalError); });',
    "",
  ].join("\n"));
  try {
    const r = await runner(a).run({ files: ["tests/deny.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "passed", JSON.stringify(r.failures) + r.outputTail);
    assert.equal(r.total, 9);
    assert.ok(!existsSync(outsideWrite));
    assert.ok(!existsSync(join(a.repo, "src/new.js")));
    assert.ok(existsSync(join(a.tmp, "ok.txt")));
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("fetch and net.connect are blocked by the kit preload (which wins over the test-only import)", async () => {
  const a = await makeAttempt({
    "tests/net.test.js": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
      'const denied = (e) => e && e.code === "ERR_ACCESS_DENIED";',
      'test("fetch", async () => { await assert.rejects(fetch("http://127.0.0.1:9/"), (e) => e.name === "SandboxNetworkDenied" && denied(e)); });',
      'test("import net", async () => { await assert.rejects(import("node:net"), denied); });',
      'test("require net", () => { assert.throws(() => require("net").connect(9, "127.0.0.1"), denied); });',
      'test("getBuiltinModule net", () => { assert.throws(() => process.getBuiltinModule("net"), denied); });',
      'test("dns, http, https, http2, tls, dgram", async () => { for (const m of ["dns", "node:dns/promises", "http", "https", "http2", "tls", "dgram"]) await assert.rejects(import(m), denied, m); });',
      'test("WebSocket", () => { assert.throws(() => new WebSocket("ws://127.0.0.1:9/"), denied); });',
      'test("fetch cannot be restored", () => { assert.throws(() => { globalThis.fetch = async () => new Response("x"); }, TypeError); });',
      'test("no later module hooks", async () => { const m = await import("node:module"); assert.throws(() => m.registerHooks({ resolve: (s, c, n) => n(s, c) }), denied); assert.throws(() => m.default.registerHooks({}), denied); });',
      "",
    ].join("\n"),
  });
  try {
    const r = await runner(a).run({ files: ["tests/net.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "passed", JSON.stringify(r.failures) + r.outputTail);
    assert.equal(r.total, 8);
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("the timeout kills the whole process group", async () => {
  const a = await makeAttempt({
    "tests/hang.test.js": [
      'import { test } from "node:test";',
      'test("hangs", async () => { console.log("CHILD-PID " + process.pid); setInterval(() => {}, 1000); await new Promise(() => {}); });',
      "",
    ].join("\n"),
  });
  try {
    const started = Date.now();
    const r = await runner(a).run({ files: ["tests/hang.test.js"], timeoutSec: 2, signal: signal() });
    assert.equal(r.outcome, "timeout");
    assert.equal(r.exitCode, null);
    assert.ok(Date.now() - started < 15_000);
    const pid = Number(/CHILD-PID (\d+)/.exec(r.outputTail)?.[1]);
    assert.ok(pid > 0, r.outputTail);
    assert.equal(isAlive(pid), false);
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("the timeout kills a grandchild in the group too (a wrapper in unshare's place starts one, then execs node)", async () => {
  const a = await makeAttempt({
    "tests/hang.test.js": 'import { test } from "node:test";\ntest("hangs", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
  });
  const wrapper = join(a.base, "fake-unshare");
  // Drops "--user --map-root-user --net --" like unshare would, after leaving a long sleep behind in the same group.
  await writeFile(wrapper, '#!/bin/sh\nsleep 300 &\necho "GRANDCHILD-PID $!"\nshift 4\nexec "$@"\n');
  await chmod(wrapper, 0o755);
  try {
    const r = await runner(a, { network: "isolated", unsharePath: wrapper }).run({ files: ["tests/hang.test.js"], timeoutSec: 2, signal: signal() });
    assert.equal(r.outcome, "timeout", r.outputTail);
    const pid = Number(/GRANDCHILD-PID (\d+)/.exec(r.outputTail)?.[1]);
    assert.ok(pid > 0, r.outputTail);
    let alive = isAlive(pid);
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise((res) => setTimeout(res, 100));
      alive = isAlive(pid);
    }
    if (alive) process.kill(pid, "SIGKILL");
    assert.equal(alive, false, "the grandchild outlived the group kill");
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("a process that escapes the group and holds the pipes cannot hang the run: it ends as an error", async () => {
  const a = await makeAttempt({ "tests/ok.test.js": 'import { test } from "node:test";\ntest("ok", () => {});\n' });
  const wrapper = join(a.base, "fake-unshare");
  // Outside the sandbox (in unshare's place): a sleep in a new session inherits stdout, then node runs the suite.
  await writeFile(wrapper, [
    "#!/bin/sh",
    "shift 4",
    `"$1" -e 'const c = require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: ["ignore", 1, 2] }); console.log("ESCAPED-PID " + c.pid); c.unref();'`,
    'exec "$@"',
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  let pid = 0;
  try {
    const started = Date.now();
    const r = await runner(a, { network: "isolated", unsharePath: wrapper }).run({ files: ["tests/ok.test.js"], timeoutSec: 60, signal: signal() });
    pid = Number(/ESCAPED-PID (\d+)/.exec(r.outputTail)?.[1]);
    assert.ok(pid > 0, r.outputTail);
    assert.equal(r.outcome, "error");
    assert.ok(Date.now() - started < 15_000);
  } finally {
    if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
    await rm(a.base, { recursive: true, force: true });
  }
});

test("an abort signal also kills the process group and the run is an error", async () => {
  const a = await makeAttempt({
    "tests/hang.test.js": 'import { test } from "node:test";\ntest("hangs", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
  });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const r = await runner(a).run({ files: ["tests/hang.test.js"], timeoutSec: 60, signal: ac.signal });
    assert.equal(r.outcome, "error");
    assert.equal(r.exitCode, null);
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("output over maxOutputBytes is capped (tail kept) and the report still parses", async () => {
  const a = await makeAttempt({
    "tests/loud.test.js": [
      'import { test } from "node:test";',
      'test("loud", () => { for (let i = 0; i < 2000; i++) console.log("line " + i + " " + "x".repeat(100)); console.error("LAST-STDERR"); });',
      "",
    ].join("\n"),
  });
  try {
    const r = await runner(a, { maxOutputBytes: 4096 }).run({ files: ["tests/loud.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "passed", r.outputTail.slice(0, 300));
    assert.equal(r.total, 1);
    assert.ok(Buffer.byteLength(r.outputTail) <= 4096, String(Buffer.byteLength(r.outputTail)));
    assert.match(r.outputTail, /LAST-STDERR/);
    assert.ok(!r.outputTail.includes("line 0 "));
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("a secret in the output and in a failure message is redacted", async () => {
  const secret = "sk-or-v1-" + "e".repeat(40);
  const a = await makeAttempt({
    "tests/leak.test.js": [
      'import { test } from "node:test";',
      `const s = ${JSON.stringify(secret)};`,
      'test("prints", () => { console.log("token=" + s); });',
      'test("throws", () => { throw new Error("bad token " + s); });',
      "",
    ].join("\n"),
  });
  try {
    const r = await runner(a, { secrets: [secret] }).run({ files: ["tests/leak.test.js"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "failed");
    assert.ok(!JSON.stringify(r).includes(secret));
    assert.ok(r.outputTail.includes(`token=${REDACTED}`));
    assert.match(r.failures[0]!.message, /REDACTED/);
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("an unsafe test file argument is refused without spawning", async () => {
  const a = await makeAttempt();
  try {
    const r = await runner(a).run({ files: ["--inspect"], timeoutSec: 60, signal: signal() });
    assert.equal(r.outcome, "error");
    assert.equal(r.exitCode, null);
  } finally {
    await rm(a.base, { recursive: true, force: true });
  }
});

test("self-test, isolated, with an unshare wrapper that exits 1: the sandbox is unavailable", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "ic-sbx-fake-"));
  try {
    const fake = join(dir, "unshare");
    await writeFile(fake, "#!/bin/sh\nexit 1\n");
    await chmod(fake, 0o755);
    const r = await runSandboxSelfTest({ network: "isolated", unsharePath: fake, extraImports: [NO_NETWORK] });
    assert.equal(r.ok, false);
    assert.equal(r.network, "isolated");
    assert.ok(r.failed.length > 0);
    assert.ok(r.failed.includes("tcp_loopback_blocked") && r.failed.includes("child_process_denied"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-test, best_effort: every permission check passes and the network checks are not claimed", async () => {
  const r = await runSandboxSelfTest({ network: "best_effort", extraImports: [NO_NETWORK], readTargets: [projectPath("copilot.yaml"), projectPath("data/copilot.db")] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.failed, []);
  const ids = r.checks.map((c) => c.id);
  assert.ok(!ids.includes("tcp_loopback_blocked") && !ids.includes("tcp_github_blocked"));
  for (const id of ["env_secret_absent", "child_process_denied", "child_process_denied_os", "write_outside_tmp_denied", "copilot_read_denied", "preload_blocks_network"] as const) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(SELF_TEST_CHECKS.includes("tcp_github_blocked"));
});

function realUnshareWorks(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "--net", "true"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const unshareSkip = process.platform !== "linux"
  ? `unshare is Linux only (platform ${process.platform})`
  : realUnshareWorks() ? false : "unshare --user --net is not permitted on this host";

test("self-test, isolated, with the real unshare", { skip: unshareSkip }, async () => {
  const r = await runSandboxSelfTest({ network: "isolated", extraImports: [NO_NETWORK] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.checks.some((c) => c.id === "tcp_loopback_blocked" && c.ok));
});
