// Conformance kit for notifiers (spec 008, AC-56 and AC-59). Call it from tests/unit/notifiers-<type>.unit.test.ts.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NotifierDefinition, Notifier } from "../../src/notifiers/types.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createFakeFetch } from "./fake-fetch.ts";
import type { FakeRoute } from "./fake-fetch.ts";
import { sampleNotificationMessage } from "./notifications.ts";

export type NotifierConformanceOptions = {
  env: Record<string, string>;
  /** The copilot.yaml notifier entry without id and type (it may carry events). */
  entry: Record<string, unknown>;
  secrets: string[];
  okRoutes: FakeRoute[];
  failureRoutes(kind: "retryable" | "permanent"): FakeRoute[];
};

export const CONFORMANCE_NOTIFIER_ID = "conformance";

export function describeNotifierConformance(definition: NotifierDefinition<unknown>, o: NotifierConformanceOptions): void {
  const parse = () => {
    const text = JSON.stringify({ version: 1, notifiers: [{ id: CONFORMANCE_NOTIFIER_ID, type: definition.type, ...o.entry }] });
    const r = parseCopilotConfig(text, { format: "json", env: o.env, connectors: [], notifiers: [definition] });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
    return r.config;
  };
  const build = (routes: FakeRoute[], logs: string[]): Notifier => {
    const { fetch } = createFakeFetch(routes);
    return definition.create(parse().notifiers[0]!.config, {
      id: CONFORMANCE_NOTIFIER_ID,
      http: createHttpClient({ fetch, timeoutMs: 2000 }),
      logger: createLogger({ level: "debug", secrets: o.secrets, write: (l) => void logs.push(l) }),
    });
  };
  const leaks = (text: string) => o.secrets.filter((s) => s.length > 0 && text.includes(s));
  const signal = () => new AbortController().signal;

  describe(`notifier conformance: ${definition.type}`, () => {
    test("the entry parses and every secret joins the redaction list", () => {
      const c = parse();
      for (const s of o.secrets) assert.ok(c.secrets.includes(s), "a configured secret is missing from the redaction list");
    });
    test("send succeeds on the ok routes", async () => {
      const logs: string[] = [];
      assert.deepEqual(await build(o.okRoutes, logs).send(sampleNotificationMessage(), { signal: signal() }), { ok: true });
      assert.deepEqual(leaks(logs.join("\n")), []);
    });
    for (const kind of ["retryable", "permanent"] as const) {
      test(`a ${kind} failure is an outcome, not an exception, without secrets`, async () => {
        const logs: string[] = [];
        const out = await build(o.failureRoutes(kind), logs).send(sampleNotificationMessage(), { signal: signal() });
        assert.equal(out.ok, false);
        assert.ok(!out.ok && out.retryable === (kind === "retryable"));
        assert.deepEqual(leaks(JSON.stringify(out) + logs.join("\n")), []);
      });
    }
    test("the abort signal is honored", async () => {
      const slow = o.okRoutes.map((r) => ({ ...r, delayMs: 5000 }));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      const started = Date.now();
      const out = await build(slow, []).send(sampleNotificationMessage(), { signal: ac.signal });
      assert.equal(out.ok, false);
      assert.ok(Date.now() - started < 2000, "send returned soon after the abort");
      assert.deepEqual(leaks(JSON.stringify(out)), []);
    });
  });
}
