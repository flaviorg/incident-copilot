import { test } from "node:test";
import assert from "node:assert/strict";
import { runNode } from "../helpers/spawn.ts";

test("fetch is disabled during tests", async () => {
  await assert.rejects(fetch("https://example.com"), { name: "NetworkDisabledInTests" });
});

test("child processes started by the test helpers also have fetch disabled (AC-27)", async () => {
  // runNode é a mesma rotina que sobe a CLI (runCli) e usa os mesmos argumentos do servidor MCP de teste (CHILD_NODE_ARGS).
  const r = await runNode(["-e", "fetch('https://example.com').then(() => console.log('rede liberada'), (e) => console.log(e.name))"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "NetworkDisabledInTests");
});
