// Spec 009, decision 7 (AC-66): the sandbox self-test probe. Self-contained (only node:* imports). The self-test copies
// it into a throwaway work tree and runs it through the full runner; each test is one check, named by its id, and
// passes only when the sandbox denies what it must. The parent writes the probe's inputs to <attempt>/tmp.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type ProbeConfig = {
  phase: "preload" | "os";
  network: "isolated" | "best_effort";
  envKeys: string[];
  plantedKey: string;
  plantedValue: string;
  forbiddenEnv: string[];
  readTargets: string[];
  writeTargets: string[];
  loopbackPort: number | null;
  githubHost: string;
};

const config = JSON.parse(fs.readFileSync(`${process.env.TMPDIR ?? ""}/probe-config.json`, "utf8")) as ProbeConfig;

function isDenied(e: unknown): boolean {
  return e !== null && typeof e === "object" && (e as { code?: unknown }).code === "ERR_ACCESS_DENIED";
}

/** Resolves true when the connection fails or does not open within `ms`; false only when it connects. */
async function tcpFails(host: string, port: number, ms: number): Promise<boolean> {
  const net = process.getBuiltinModule("node:net");
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (failed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(failed);
    };
    const timer = setTimeout(() => done(true), ms);
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
  });
}

if (config.phase === "preload") {
  test("env_secret_absent", () => {
    const keys = Object.keys(process.env);
    for (const k of keys) assert.ok(config.envKeys.includes(k), `unexpected env key ${k}`);
    assert.equal(process.env[config.plantedKey], undefined);
    for (const k of config.forbiddenEnv) assert.equal(process.env[k], undefined, k);
    assert.ok(!Object.values(process.env).some((v) => typeof v === "string" && v.includes(config.plantedValue)));
  });

  test("child_process_denied", async () => {
    await assert.rejects(import("node:child_process"), isDenied);
    assert.throws(() => process.getBuiltinModule("node:child_process"), isDenied);
  });

  test("write_outside_tmp_denied", () => {
    assert.ok(config.writeTargets.length > 0);
    for (const p of config.writeTargets) assert.throws(() => fs.writeFileSync(p, "x"), isDenied, p);
    fs.writeFileSync(`${process.env.TMPDIR ?? ""}/probe-write-ok.txt`, "ok");
  });

  test("copilot_read_denied", () => {
    assert.ok(config.readTargets.length > 0);
    for (const p of config.readTargets) assert.throws(() => fs.readFileSync(p), isDenied, p);
  });

  test("preload_blocks_network", async () => {
    await assert.rejects(fetch("http://127.0.0.1:9/"), isDenied);
    await assert.rejects(import("node:net"), isDenied);
    assert.throws(() => process.getBuiltinModule("node:net"), isDenied);
  });
} else {
  test("child_process_denied_os", async () => {
    const cp = await import("node:child_process");
    assert.throws(() => cp.execFileSync("/bin/sh", ["-c", "exit 0"]), isDenied);
  });

  if (config.network === "isolated") {
    test("tcp_loopback_blocked", async () => {
      assert.ok(config.loopbackPort !== null && config.loopbackPort > 0);
      assert.equal(await tcpFails("127.0.0.1", config.loopbackPort, 3000), true);
    });

    test("tcp_github_blocked", async () => {
      assert.equal(await tcpFails(config.githubHost, 443, 5000), true);
    });
  }
}
