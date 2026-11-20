// Conformance kit (spec 008, AC-59): the same invariants for every connector type. Call it from
// tests/unit/connectors-<type>.unit.test.ts; it registers node:test tests and skips the sections whose capability the
// definition does not declare.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NormalizedAlertSchema } from "../../src/contracts/index.ts";
import type { ConnectorDefinition, ConnectorInstance, InboundRequest, QueryCapability, QueryIO } from "../../src/connectors/types.ts";
import { createConnectorInstance } from "../../src/connectors/registry.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import type { ConnectorEntry } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createFakeFetch } from "./fake-fetch.ts";
import type { FakeRoute } from "./fake-fetch.ts";
import { inboundRequest } from "./inbound.ts";
import { resolveFromRoot } from "./fixtures.ts";

export type ConnectorFailureKind = "auth" | "rate_limited" | "bad_response" | "network";

export type ConnectorConformanceOptions = {
  /** Environment for ${VAR} interpolation; secret values go in `secrets` too. */
  env: Record<string, string>;
  /** The copilot.yaml entry without id and type (it may carry enabled and severityMap). */
  entry: Record<string, unknown>;
  /** Every secret value the entry resolves; none may appear in any output. */
  secrets: string[];
  /** Adds valid credentials (headers, path token or signature over rawBody). */
  withCredentials(req: InboundRequest): InboundRequest;
  /** Adds credentials of the right shape and the wrong value. */
  withWrongCredentials(req: InboundRequest): InboundRequest;
  /** Payload files (paths from the project root) and what parse must make of each. */
  payloads: { file: string; expect: "alerts" | "ignored"; count?: number }[];
  query?: {
    routes: FakeRoute[];
    exercise(q: QueryCapability, io: QueryIO): Promise<unknown>;
    failureRoutes(kind: ConnectorFailureKind): FakeRoute[];
  };
};

export const CONFORMANCE_CONNECTOR_ID = "conformance";
const NOW = new Date("2026-10-04T10:00:00.000Z");

function parseEntry(definition: ConnectorDefinition<unknown>, o: ConnectorConformanceOptions): ConnectorEntry {
  const text = JSON.stringify({ version: 1, connectors: [{ id: CONFORMANCE_CONNECTOR_ID, type: definition.type, ...o.entry }] });
  const r = parseCopilotConfig(text, { format: "json", env: o.env, connectors: [definition], notifiers: [] });
  assert.ok(r.ok, `the entry must parse: ${JSON.stringify(!r.ok && r.problems)}`);
  return r.config.connectors[0]!;
}

function build(definition: ConnectorDefinition<unknown>, entry: ConnectorEntry, routes: FakeRoute[], logs: string[], secrets: string[]): ConnectorInstance {
  const { fetch } = createFakeFetch(routes);
  return createConnectorInstance(definition, entry, {
    http: createHttpClient({ fetch, timeoutMs: 2000 }),
    fetch,
    now: () => NOW,
    logger: createLogger({ level: "debug", secrets, write: (l) => void logs.push(l) }),
  });
}

const leaks = (text: string, secrets: string[]) => secrets.filter((s) => s.length > 0 && text.includes(s));

/** 200 levels of nesting and a 10,000-key object: parse must neither throw nor hang. */
function garbage(): unknown[] {
  let deep: unknown = {};
  for (let i = 0; i < 200; i++) deep = { alerts: [deep], a: deep };
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 10_000; i++) wide[`k${i}`] = i;
  return [null, 1, "x", [], {}, { alerts: null }, { alerts: [null, 1, "x", {}] }, deep, wide];
}

export function describeConnectorConformance(definition: ConnectorDefinition<unknown>, o: ConnectorConformanceOptions): void {
  describe(`connector conformance: ${definition.type}`, () => {
    test("the entry parses through parseCopilotConfig and every secret joins the redaction list", () => {
      const text = JSON.stringify({ version: 1, connectors: [{ id: CONFORMANCE_CONNECTOR_ID, type: definition.type, ...o.entry }] });
      const r = parseCopilotConfig(text, { format: "json", env: o.env, connectors: [definition], notifiers: [] });
      assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
      for (const s of o.secrets) assert.ok(r.config.secrets.includes(s), "a configured secret is missing from the redaction list");
      assert.deepEqual(r.config.connectors[0]!.capabilities, [...definition.capabilities]);
      assert.equal(typeof definition.displayName, "string");
    });

    const declaresIngest = definition.capabilities.includes("ingest");
    describe("ingest", { skip: declaresIngest ? false : "no ingest capability" }, () => {
      const logs: string[] = [];
      const firstPayload = () => readFileSync(resolveFromRoot(o.payloads[0]!.file), "utf8");
      const instance = () => {
        const i = build(definition, parseEntry(definition, o), [], logs, o.secrets);
        assert.ok(i.ingest, "the instance must expose ingest for this entry");
        return i;
      };

      test("verify: ok with credentials, not ok without them or with wrong ones", () => {
        const ing = instance().ingest!;
        const req = inboundRequest({ connectorId: CONFORMANCE_CONNECTOR_ID, body: firstPayload() });
        assert.deepEqual(ing.verify(o.withCredentials(req)), { ok: true });
        assert.equal(ing.verify(req).ok, false);
        assert.equal(ing.verify(o.withWrongCredentials(req)).ok, false);
      });

      test("payload files parse to the expected outcome and every alert passes NormalizedAlertSchema", () => {
        assert.ok(o.payloads.length > 0, "at least one payload file");
        const ing = instance().ingest!;
        for (const p of o.payloads) {
          const text = readFileSync(resolveFromRoot(p.file), "utf8");
          const req = o.withCredentials(inboundRequest({ connectorId: CONFORMANCE_CONNECTOR_ID, body: text }));
          assert.deepEqual(ing.verify(req), { ok: true }, p.file);
          const out = ing.parse(JSON.parse(text), req);
          assert.equal(out.kind, p.expect, `${p.file}: ${JSON.stringify(out)}`);
          if (out.kind === "alerts") {
            if (p.count !== undefined) assert.equal(out.alerts.length, p.count, p.file);
            for (const a of out.alerts) {
              NormalizedAlertSchema.parse(a);
              assert.equal(a.source, definition.type, "source is the connector type");
            }
          }
          assert.deepEqual(leaks(JSON.stringify(out), o.secrets), [], p.file);
        }
      });

      test("parse never throws on garbage and answers one of the three outcomes", () => {
        const ing = instance().ingest!;
        const req = o.withCredentials(inboundRequest({ connectorId: CONFORMANCE_CONNECTOR_ID, body: "{}" }));
        for (const g of garbage()) {
          const out = ing.parse(g, req);
          assert.ok(["alerts", "ignored", "invalid"].includes(out.kind));
          if (out.kind === "alerts") for (const a of out.alerts) NormalizedAlertSchema.parse(a);
          if (out.kind === "invalid") assert.ok(out.issues.every((i) => typeof i === "string" && i.length <= 200));
          assert.deepEqual(leaks(JSON.stringify(out), o.secrets), []);
        }
      });

      test("no secret in verify outcomes or logs", () => {
        const ing = instance().ingest!;
        const req = inboundRequest({ connectorId: CONFORMANCE_CONNECTOR_ID, body: firstPayload() });
        const outcomes = [ing.verify(req), ing.verify(o.withWrongCredentials(req)), ing.verify(o.withCredentials(req))];
        assert.deepEqual(leaks(JSON.stringify(outcomes) + logs.join("\n"), o.secrets), []);
      });
    });

    const q = o.query;
    describe("query", { skip: definition.capabilities.includes("query") && q ? false : "no query capability or no query options" }, () => {
      const io = (): QueryIO => ({ signal: new AbortController().signal, now: NOW });
      test("exercise succeeds on the documented routes", async () => {
        const logs: string[] = [];
        const i = build(definition, parseEntry(definition, o), q!.routes, logs, o.secrets);
        assert.ok(i.query, "the instance must expose query for this entry");
        await q!.exercise(i.query, io());
        assert.deepEqual(leaks(logs.join("\n"), o.secrets), []);
      });
      for (const kind of ["auth", "rate_limited", "bad_response", "network"] as const) {
        test(`a ${kind} failure becomes ConnectorError(${kind === "network" ? "unavailable" : kind}) without secrets`, async () => {
          const logs: string[] = [];
          const i = build(definition, parseEntry(definition, o), q!.failureRoutes(kind), logs, o.secrets);
          await assert.rejects(q!.exercise(i.query!, io()), (e: unknown) => {
            assert.ok(e instanceof ConnectorError, `expected ConnectorError, got ${String(e)}`);
            assert.equal(e.kind, kind === "network" ? "unavailable" : kind);
            assert.deepEqual(leaks(`${e.message} ${String(e.stack)}`, o.secrets), []);
            return true;
          });
          assert.deepEqual(leaks(logs.join("\n"), o.secrets), []);
        });
      }
    });
  });
}
