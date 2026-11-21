// Every registered connector and notifier type ships a setup guide and a conformance test (spec 008, AC-59), and the
// registry builds only enabled entries with the capabilities their instances expose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { CONNECTOR_DEFINITIONS } from "../../src/connectors/index.ts";
import { NOTIFIER_DEFINITIONS } from "../../src/notifiers/index.ts";
import { createConnectorRegistry } from "../../src/connectors/registry.ts";
import { defineConnector } from "../../src/connectors/types.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import * as z from "zod";

test("types are unique across connectors and notifiers, each with a guide and a test file", () => {
  const types = [...CONNECTOR_DEFINITIONS.map((d) => d.type), ...NOTIFIER_DEFINITIONS.map((d) => d.type)];
  assert.ok(CONNECTOR_DEFINITIONS.some((d) => d.type === "alertmanager"), "the reference connector is registered");
  assert.deepEqual([...new Set(types)].sort(), [...types].sort(), "types must be unique");
  const unitTests = readdirSync("tests/unit");
  for (const d of CONNECTOR_DEFINITIONS) {
    assert.match(d.type, /^[a-z][a-z0-9-]{0,31}$/);
    assert.ok(existsSync(`docs/connectors/${d.type}.md`), `docs/connectors/${d.type}.md is missing`);
    assert.ok(unitTests.some((f) => f.startsWith(`connectors-${d.type}`) && f.endsWith(".unit.test.ts")), `no tests/unit/connectors-${d.type}*.unit.test.ts`);
    assert.ok(d.capabilities.length > 0);
  }
  for (const d of NOTIFIER_DEFINITIONS) {
    assert.ok(existsSync(`docs/connectors/${d.type}.md`), `docs/connectors/${d.type}.md is missing`);
    assert.ok(unitTests.some((f) => f.startsWith(`notifiers-${d.type}`) && f.endsWith(".unit.test.ts")), `no tests/unit/notifiers-${d.type}*.unit.test.ts`);
  }
});

test("the registry creates enabled entries only and lists their real capabilities", async () => {
  let closed = 0;
  const both = defineConnector({
    type: "both", displayName: "Both", capabilities: ["ingest", "query"], configSchema: () => z.strictObject({ withIngest: z.boolean() }),
    create: (c, d) => ({
      id: d.id, type: "both",
      ingest: c.withIngest ? { verify: () => ({ ok: true }), parse: () => ({ kind: "ignored", reason: "x" }) } : null,
      query: { errors: async () => [] },
      close: async () => void closed++,
    }),
  });
  const entry = (id: string, enabled: boolean, withIngest: boolean) => ({ id, type: "both", enabled, severityMap: null, capabilities: ["ingest", "query"] as const, config: { withIngest } });
  const { fetch } = createFakeFetch([]);
  const reg = createConnectorRegistry({
    definitions: [both], entries: [entry("a", true, true), entry("b", true, false), entry("c", false, true)], fetch, now: () => new Date(),
    logger: createLogger({ level: "error", secrets: [], write: () => {} }),
  });
  assert.deepEqual(reg.list(), [
    { id: "a", type: "both", capabilities: ["ingest", "query"], ingestPath: "/ingest/a" },
    { id: "b", type: "both", capabilities: ["query"], ingestPath: null },
  ]);
  assert.equal(reg.get("c"), null);
  assert.equal(reg.get("a")!.id, "a");
  assert.deepEqual(reg.querySources().map((s) => s.connectorId), ["a", "b"]);
  await reg.close();
  assert.equal(closed, 2);
});
