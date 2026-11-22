import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeployRecord, StackFrame } from "../../src/contracts/index.ts";
import {
  anchorFrame, isNewInRelease, locateAnchor, mapFrameToRepoPath, resolveCommitCandidate, stripPathPrefix,
  type FrameRepoConfig,
} from "../../src/domain/code-fix/frames.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const cfg: FrameRepoConfig = {
  pathPrefixes: ["/app/", "app:///", "webpack:///./"],
  sourceGlobs: ["src/**/*.{js,ts,mjs,cjs,mts,cts}"],
  deniedPaths: ["src/pricing/**"],
};

function frame(file: string, inApp = true, line = 10): StackFrame {
  return { file, line, column: 3, function: "fn", inApp };
}

// ---------- anchor frame ----------

test("anchorFrame returns the innermost (last) in-app frame", () => {
  const frames = [frame("/app/src/a.js"), frame("/app/src/b.js"), frame("node:internal/x", false)];
  assert.equal(anchorFrame(frames)?.file, "/app/src/b.js");
  assert.equal(anchorFrame([frame("x.js", false)]), null);
  assert.equal(anchorFrame([]), null);
});

// ---------- prefix stripping ----------

test("stripPathPrefix strips the first matching configured prefix", () => {
  assert.equal(stripPathPrefix("/app/src/cart.js", cfg.pathPrefixes), "src/cart.js");
  assert.equal(stripPathPrefix("app:///src/cart.js", cfg.pathPrefixes), "src/cart.js");
  assert.equal(stripPathPrefix("webpack:///./src/cart.ts", cfg.pathPrefixes), "src/cart.ts");
  assert.equal(stripPathPrefix("src/cart.js", cfg.pathPrefixes), "src/cart.js");
});

// ---------- mapping ----------

test("mapFrameToRepoPath maps each prefix to a repo path", () => {
  for (const [file, expected] of [
    ["/app/src/cart.js", "src/cart.js"],
    ["app:///src/lib/price.ts", "src/lib/price.ts"],
    ["webpack:///./src/routes/orders.mjs", "src/routes/orders.mjs"],
    ["src/cart.cts", "src/cart.cts"],
  ] as const) {
    assert.deepEqual(mapFrameToRepoPath(frame(file), cfg), { ok: true, path: expected }, file);
  }
});

test("mapFrameToRepoPath rejects unsafe or generated paths", () => {
  for (const file of [
    "/app//etc/passwd.js", // absolute after stripping
    "/srv/other/src/a.js", // absolute, no prefix
    "/app/src/../../etc/a.js",
    "/app/../src/a.js",
    "C:\\app\\src\\a.js",
    "C:/app/src/a.js",
    "/app/src\\a.js",
    "/app/src/a\0.js",
    "/app/node_modules/lib/index.js",
    "/app/src/node_modules/lib/index.js",
    "/app/src/vendor.min.js",
    "/app/dist/src/a.js",
    "/app/src/dist/a.js",
    "/app/build/a.js",
    "/app/src/build/a.js",
    "/app/~/src/a.js",
    "",
  ]) {
    assert.deepEqual(mapFrameToRepoPath(frame(file), cfg), { ok: false, reason: "path_not_allowlisted" }, JSON.stringify(file));
  }
});

test("mapFrameToRepoPath rejects a wrong extension", () => {
  for (const file of ["/app/src/a.jsx", "/app/src/a.tsx", "/app/src/a.json", "/app/src/a.py", "/app/src/a", "/app/src/a.js.map"]) {
    assert.deepEqual(mapFrameToRepoPath(frame(file), cfg), { ok: false, reason: "path_not_allowlisted" }, file);
  }
});

test("mapFrameToRepoPath: outside sourceGlobs is path_not_allowlisted", () => {
  assert.deepEqual(mapFrameToRepoPath(frame("/app/lib/a.js"), cfg), { ok: false, reason: "path_not_allowlisted" });
  assert.deepEqual(mapFrameToRepoPath(frame("/app/index.js"), cfg), { ok: false, reason: "path_not_allowlisted" });
});

test("mapFrameToRepoPath: a denied path is path_denied (built-in and config)", () => {
  assert.deepEqual(mapFrameToRepoPath(frame("/app/src/auth/login.ts"), cfg), { ok: false, reason: "path_denied" });
  assert.deepEqual(mapFrameToRepoPath(frame("/app/src/session.ts"), cfg), { ok: false, reason: "path_denied" });
  assert.deepEqual(mapFrameToRepoPath(frame("/app/src/vite.config.ts"), cfg), { ok: false, reason: "path_denied" });
  assert.deepEqual(mapFrameToRepoPath(frame("/app/src/pricing/total.ts"), cfg), { ok: false, reason: "path_denied" });
});

test("mapFrameToRepoPath: no in-app frame is no_in_app_frame", () => {
  assert.deepEqual(mapFrameToRepoPath(null, cfg), { ok: false, reason: "no_in_app_frame" });
  assert.deepEqual(mapFrameToRepoPath(frame("/app/src/a.js", false), cfg), { ok: false, reason: "no_in_app_frame" });
});

test("locateAnchor maps only the innermost in-app frame", () => {
  assert.deepEqual(locateAnchor([frame("/app/src/a.js"), frame("/app/src/b.js", true, 42), frame("x", false)], cfg), {
    ok: true, path: "src/b.js", frame: frame("/app/src/b.js", true, 42),
  });
  // The innermost in-app frame is generated code: no fallback to an outer frame.
  assert.deepEqual(locateAnchor([frame("/app/src/a.js"), frame("/app/dist/b.js")], cfg), { ok: false, reason: "path_not_allowlisted" });
  assert.deepEqual(locateAnchor([frame("x", false)], cfg), { ok: false, reason: "no_in_app_frame" });
  assert.deepEqual(locateAnchor([], cfg), { ok: false, reason: "no_in_app_frame" });
});

// ---------- commit candidate (decision 5) ----------

test("resolveCommitCandidate: the release's last commit in the allowlisted repo wins", () => {
  assert.deepEqual(resolveCommitCandidate({ sha: SHA_A, repository: "acme/web" }, `web@${SHA_B}`, "acme/web"), {
    ok: true, sha: SHA_A, source: "release_commit",
  });
});

test("resolveCommitCandidate: a commit from another repository falls back to the version", () => {
  assert.deepEqual(resolveCommitCandidate({ sha: SHA_A, repository: "evil/web" }, SHA_B, "acme/web"), {
    ok: true, sha: SHA_B, source: "version",
  });
  assert.deepEqual(resolveCommitCandidate({ sha: SHA_A, repository: null }, `web@${SHA_B}`, "acme/web"), {
    ok: true, sha: SHA_B, source: "version",
  });
});

test("resolveCommitCandidate: a malformed release commit falls back to the version", () => {
  assert.deepEqual(resolveCommitCandidate({ sha: "abc", repository: "acme/web" }, SHA_B, "acme/web"), {
    ok: true, sha: SHA_B, source: "version",
  });
});

test("resolveCommitCandidate: version as a whole or after the last @", () => {
  assert.deepEqual(resolveCommitCandidate(null, SHA_B, "acme/web"), { ok: true, sha: SHA_B, source: "version" });
  assert.deepEqual(resolveCommitCandidate(null, `@scope/web@${SHA_B}`, "acme/web"), { ok: true, sha: SHA_B, source: "version" });
  assert.deepEqual(resolveCommitCandidate(null, SHA_B.toUpperCase(), "acme/web"), { ok: true, sha: SHA_B, source: "version" });
});

test("resolveCommitCandidate: otherwise commit_unresolved", () => {
  for (const version of ["1.2.3", `web@1.2.3`, `${SHA_B}@1.2.3`, "a".repeat(39), "a".repeat(41), "", null]) {
    assert.deepEqual(resolveCommitCandidate(null, version, "acme/web"), { ok: false, reason: "commit_unresolved" }, String(version));
  }
  assert.deepEqual(resolveCommitCandidate({ sha: SHA_A, repository: "evil/web" }, "1.2.3", "acme/web"), {
    ok: false, reason: "commit_unresolved",
  });
});

// ---------- new in release ----------

function deploy(version: string, at: string): DeployRecord {
  return { version, at, environment: "production", author: null, description: null, url: null };
}

const ALERT = "2026-11-20T10:00:00.000Z";

test("isNewInRelease: first seen after the release deploy", () => {
  const deploys = [deploy("v2", "2026-11-20T09:30:00.000Z"), deploy("v1", "2026-11-19T09:00:00.000Z")];
  assert.equal(isNewInRelease(deploys, "v2", "2026-11-20T09:40:00.000Z", ALERT), true);
});

test("isNewInRelease: 5-minute margin before the deploy", () => {
  const deploys = [deploy("v2", "2026-11-20T09:30:00.000Z")];
  assert.equal(isNewInRelease(deploys, "v2", "2026-11-20T09:25:00.000Z", ALERT), true);
  assert.equal(isNewInRelease(deploys, "v2", "2026-11-20T09:24:59.999Z", ALERT), false);
});

test("isNewInRelease: the deploy may be up to 5 minutes after the alert start", () => {
  assert.equal(isNewInRelease([deploy("v2", "2026-11-20T10:05:00.000Z")], "v2", "2026-11-20T10:04:00.000Z", ALERT), true);
  assert.equal(isNewInRelease([deploy("v2", "2026-11-20T10:05:00.001Z")], "v2", "2026-11-20T10:04:00.000Z", ALERT), false);
});

test("isNewInRelease: uses the newest matching deploy", () => {
  const deploys = [deploy("v2", "2026-11-19T09:00:00.000Z"), deploy("v2", "2026-11-20T09:30:00.000Z")];
  assert.equal(isNewInRelease(deploys, "v2", "2026-11-19T10:00:00.000Z", ALERT), false);
});

test("isNewInRelease: fails closed", () => {
  const deploys = [deploy("v2", "2026-11-20T09:30:00.000Z")];
  assert.equal(isNewInRelease(deploys, "v2", null, ALERT), false);
  assert.equal(isNewInRelease(deploys, null, "2026-11-20T09:40:00.000Z", ALERT), false);
  assert.equal(isNewInRelease(deploys, "v3", "2026-11-20T09:40:00.000Z", ALERT), false);
  assert.equal(isNewInRelease([], "v2", "2026-11-20T09:40:00.000Z", ALERT), false);
  assert.equal(isNewInRelease(deploys, "v2", "not-a-date", ALERT), false);
  assert.equal(isNewInRelease(deploys, "v2", "2026-11-20T09:40:00.000Z", "garbage"), false);
});
