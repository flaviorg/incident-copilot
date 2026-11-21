// New Relic connector, query side (NerdGraph NRQL) and the NRQL renderer. The model never supplies NRQL: templates
// come from config and only allowlisted values are substituted. No network: every call goes through the fake fetch.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newRelicConnector } from "../../src/connectors/newrelic/index.ts";
import { DEFAULT_NRQL, renderNrql, validateNrqlTemplate } from "../../src/connectors/newrelic/nrql.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { createConnectorInstance } from "../../src/connectors/registry.ts";
import type { QueryCapability, QueryIO } from "../../src/connectors/types.ts";
import { DeployRecordSchema, ErrorGroupSchema, LogEntrySchema, MetricSeriesSchema } from "../../src/contracts/index.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import type { FakeCall } from "../helpers/fake-fetch.ts";

const API_KEY = "NRAK-" + "Z9y8X7w6".repeat(5);
const DIR = "tests/fixtures/connectors/newrelic";
const fixture = (name: string) => JSON.parse(readFileSync(`${DIR}/${name}`, "utf8")) as unknown;
const NOW = new Date("2026-10-04T10:00:00.000Z");
const WINDOW = { from: new Date("2026-10-04T09:30:00.000Z"), to: NOW };
const io = (): QueryIO => ({ signal: new AbortController().signal, now: NOW });
const US = "https://api.newrelic.com/graphql";
const EU = "https://api.eu.newrelic.com/graphql";
const SERVICE = "Checkout API (prod)";

const response = (results: unknown) => ({ data: { actor: { account: { nrql: { results } } } } });

/** One NerdGraph URL serves every query, so the fake answers by the NRQL in the request body. */
function nerdgraph(answer: (nrql: string) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: FakeCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ method: String(init.method ?? "GET").toUpperCase(), url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()), body });
    let nrql = "";
    try {
      nrql = String((JSON.parse(body) as { variables?: { nrql?: unknown } }).variables?.nrql ?? "");
    } catch { /* not a NerdGraph body */ }
    const a = answer(nrql);
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const standard = (nrql: string) => {
  if (/FROM Log/.test(nrql)) return { body: fixture("nerdgraph-logs.json") };
  if (/FROM TransactionError/.test(nrql)) return { body: fixture("nerdgraph-facet-errors.json") };
  if (/FROM Deployment/.test(nrql)) return { body: fixture("nerdgraph-deploys.json") };
  if (/percentile/.test(nrql)) return { body: fixture("nerdgraph-timeseries-nested.json") };
  return { body: fixture("nerdgraph-timeseries.json") };
};

function queryOf(fetchFn: typeof fetch, queryEntry: Record<string, unknown> = {}): QueryCapability {
  const text = JSON.stringify({ version: 1, connectors: [{ id: "nr", type: "newrelic", query: { accountId: 1234567, apiKey: "${NR_API_KEY}", ...queryEntry } }] });
  const r = parseCopilotConfig(text, { format: "json", env: { NR_API_KEY: API_KEY }, connectors: [newRelicConnector], notifiers: [] });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const i = createConnectorInstance(newRelicConnector, r.config.connectors[0]!, {
    http: createHttpClient({ fetch: fetchFn, timeoutMs: 2000 }), fetch: fetchFn, now: () => NOW,
    logger: createLogger({ level: "debug", secrets: [API_KEY], write: () => {} }),
  });
  assert.ok(i.query);
  return i.query;
}

describe("renderNrql", () => {
  const values = { service: SERVICE, since: 1791106800000, until: 1791108600000, limit: 20, level: "ERROR" as const };

  test("substitutes the placeholders of every default template", () => {
    assert.equal(
      renderNrql(DEFAULT_NRQL.metrics.error_rate!, values),
      "SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName = 'Checkout API (prod)' SINCE 1791106800000 UNTIL 1791108600000 TIMESERIES",
    );
    assert.match(renderNrql(DEFAULT_NRQL.errors, values), /LIMIT 20$/);
    assert.match(renderNrql(DEFAULT_NRQL.logs, values), /level = 'ERROR' SINCE 1791106800000 UNTIL 1791108600000 LIMIT 20$/);
    assert.match(renderNrql(DEFAULT_NRQL.deploys, values), /SINCE 1791106800000 LIMIT 10$/);
    for (const t of [...Object.values(DEFAULT_NRQL.metrics), DEFAULT_NRQL.errors, DEFAULT_NRQL.logs, DEFAULT_NRQL.deploys]) {
      assert.equal(/\{\w+\}/.test(renderNrql(t, values)), false, "no placeholder is left");
    }
  });

  test("the default templates are valid", () => {
    for (const t of Object.values(DEFAULT_NRQL.metrics)) assert.equal(validateNrqlTemplate(t, ["service", "since", "until"]), null);
    assert.equal(validateNrqlTemplate(DEFAULT_NRQL.errors, ["service", "since", "until", "limit"]), null);
    assert.equal(validateNrqlTemplate(DEFAULT_NRQL.logs, ["service", "since", "until", "limit", "level"]), null);
    assert.equal(validateNrqlTemplate(DEFAULT_NRQL.deploys, ["service", "since", "until", "limit"]), null);
  });

  const unsafe = (service: string) => assert.throws(() => renderNrql(DEFAULT_NRQL.metrics.error_rate!, { service, since: 1, until: 2 }), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input");

  test("refuses a service that could change the query", () => {
    unsafe("x' OR '1'='1");
    unsafe("x' OR 1=1 --");
    unsafe("x' OR 1=1");
    unsafe("x'");
    unsafe('x"');
    unsafe("x\nSINCE 1 year ago");
    unsafe("x\n"); // a trailing newline
    unsafe("x\r\ny");
    unsafe("x\\");
    unsafe("x; DROP");
    unsafe("x`y");
    unsafe("x{limit}");
    unsafe("x$y");
    unsafe("x%");
    unsafe("x*");
    unsafe("x,y");
    unsafe("x=y");
    unsafe("x|y");
    unsafe("");
    unsafe("a".repeat(121));
    unsafe("café");
    unsafe("x\u0000");
  });

  test("accepts the documented character set and 120 characters", () => {
    for (const s of ["checkout-api", "Checkout API (prod)", "svc.v2:eu/west [blue]", "a".repeat(120)]) {
      assert.match(renderNrql(DEFAULT_NRQL.metrics.error_rate!, { service: s, since: 1, until: 2 }), /^SELECT/);
    }
  });

  test("numbers must be safe integers and a level is ERROR or WARN", () => {
    const t = DEFAULT_NRQL.logs;
    for (const bad of [1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => renderNrql(t, { ...values, since: bad }), ConnectorError);
      assert.throws(() => renderNrql(t, { ...values, limit: bad }), ConnectorError);
    }
    assert.throws(() => renderNrql(t, { ...values, since: "1" as unknown as number }), ConnectorError);
    assert.throws(() => renderNrql(t, { ...values, level: "INFO" as unknown as "ERROR" }), ConnectorError);
    assert.throws(() => renderNrql(t, { ...values, level: "ERROR' OR '1'='1" as unknown as "ERROR" }), ConnectorError);
    assert.throws(() => renderNrql(t, { service: SERVICE, since: 1, until: 2, limit: 5 }), ConnectorError, "a used placeholder without a value");
  });

  test("a substituted value is never scanned again for placeholders", () => {
    assert.equal(renderNrql("SELECT 1 FROM T WHERE a = '{service}' LIMIT {limit}", { service: "x y", limit: 5 }), "SELECT 1 FROM T WHERE a = 'x y' LIMIT 5");
  });

  test("validateNrqlTemplate rejects bad templates with fixed texts", () => {
    const allowed = ["service", "since", "until"] as const;
    assert.equal(validateNrqlTemplate("  select 1 from T where a = '{service}'", allowed), null, "leading spaces and lower case are fine");
    assert.equal(validateNrqlTemplate("from T SELECT 1 where a = '{service}'", allowed), null);
    assert.match(validateNrqlTemplate("UPDATE x '{service}'", allowed)!, /SELECT or FROM/);
    assert.match(validateNrqlTemplate("SELECT 1 FROM T", allowed)!, /\{service\}/);
    assert.match(validateNrqlTemplate("SELECT 1 FROM T WHERE a = {service}", allowed)!, /single quotes/);
    assert.match(validateNrqlTemplate("SELECT 1 FROM T WHERE a = \"{service}\"", allowed)!, /single quotes/);
    assert.match(validateNrqlTemplate("SELECT 1 FROM T WHERE a = '{service}' LIMIT {limit}", allowed)!, /placeholder/);
    assert.match(validateNrqlTemplate("SELECT 1 FROM T WHERE a = '{service}' {nope}", allowed)!, /placeholder/);
  });
});

describe("query capability", () => {
  test("posts the NerdGraph query with the API-Key header to the US endpoint", async () => {
    const { fetch, calls } = nerdgraph(standard);
    const q = queryOf(fetch);
    await q.metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io());
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.method, "POST");
    assert.equal(c.url, US);
    assert.equal(c.headers["api-key"], API_KEY);
    assert.equal(c.headers["content-type"], "application/json");
    const body = JSON.parse(c.body!) as { query: string; variables: { accountId: number; nrql: string } };
    assert.equal(body.query, "query($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) { nrql(query: $nrql) { results } } } }");
    assert.equal(body.variables.accountId, 1234567);
    assert.equal(body.variables.nrql, `SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName = 'Checkout API (prod)' SINCE ${WINDOW.from.getTime()} UNTIL ${WINDOW.to.getTime()} TIMESERIES`);
    assert.deepEqual(Object.keys(body).sort(), ["query", "variables"]);
  });

  test("region eu uses the EU endpoint", async () => {
    const { fetch, calls } = nerdgraph(standard);
    await queryOf(fetch, { region: "eu" }).metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io());
    assert.equal(calls[0]!.url, EU);
  });

  test("the API key never appears in the request body or URL", async () => {
    const { fetch, calls } = nerdgraph(standard);
    await queryOf(fetch).metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io());
    assert.equal(calls[0]!.body!.includes(API_KEY) || calls[0]!.url.includes(API_KEY), false);
  });

  test("metricNames are the keys of the metrics templates; unknown metrics answer null without a request", async () => {
    const { fetch, calls } = nerdgraph(standard);
    const q = queryOf(fetch);
    assert.deepEqual([...q.metricNames!].sort(), ["error_rate", "latency_p99", "throughput"]);
    assert.equal(await q.metrics!({ service: SERVICE, metric: "cpu", window: WINDOW }, io()), null);
    assert.equal(calls.length, 0);
  });

  test("custom metric templates add to the defaults and override by name", async () => {
    const { fetch, calls } = nerdgraph(standard);
    const custom = "SELECT average(duration) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES";
    const q = queryOf(fetch, { nrql: { metrics: { avg_latency: custom, throughput: custom } } });
    assert.deepEqual([...q.metricNames!].sort(), ["avg_latency", "error_rate", "latency_p99", "throughput"]);
    await q.metrics!({ service: SERVICE, metric: "throughput", window: WINDOW }, io());
    assert.match(JSON.parse(calls[0]!.body!).variables.nrql, /^SELECT average\(duration\)/);
  });

  test("metrics: TIMESERIES rows become points; null values are skipped; epoch seconds become ISO", async () => {
    const q = queryOf(nerdgraph(standard).fetch);
    const s = (await q.metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io()))!;
    MetricSeriesSchema.parse(s);
    assert.deepEqual(s, {
      metric: "error_rate", unit: null,
      points: [
        { ts: "2026-10-04T09:40:00.000Z", value: 0.4 },
        { ts: "2026-10-04T09:41:00.000Z", value: 0.5 },
        { ts: "2026-10-04T09:42:00.000Z", value: 7.25 },
      ],
    });
  });

  test("metrics: the value is the first numeric leaf that is not a time key, nested objects included", async () => {
    const q = queryOf(nerdgraph(standard).fetch);
    const s = (await q.metrics!({ service: SERVICE, metric: "latency_p99", window: WINDOW }, io()))!;
    assert.deepEqual(s.points.map((p) => p.value), [0.42, 1.9]);
    const rows = [{ endTimeSeconds: 1791106860, beginTimeSeconds: 1791106800, label: "x", "average.duration": 3 }, { beginTimeSeconds: 1791106860, a: { b: { c: 9 } } }, { beginTimeSeconds: "bad", v: 1 }, { v: 2 }, "junk", null];
    const q2 = queryOf(nerdgraph(() => ({ body: response(rows) })).fetch);
    const s2 = (await q2.metrics!({ service: SERVICE, metric: "throughput", window: WINDOW }, io()))!;
    assert.deepEqual(s2.points, [{ ts: "2026-10-04T09:40:00.000Z", value: 3 }, { ts: "2026-10-04T09:41:00.000Z", value: 9 }]);
  });

  test("metrics: at most 500 points, the latest ones, in time order", async () => {
    const rows = Array.from({ length: 700 }, (_, i) => ({ beginTimeSeconds: 1791000000 + i * 60, endTimeSeconds: 1791000060 + i * 60, v: i }));
    const q = queryOf(nerdgraph(() => ({ body: response(rows.reverse()) })).fetch);
    const s = (await q.metrics!({ service: SERVICE, metric: "throughput", window: WINDOW }, io()))!;
    assert.equal(s.points.length, 500);
    assert.equal(s.points[0]!.value, 200);
    assert.equal(s.points[499]!.value, 699);
    MetricSeriesSchema.parse(s);
  });

  test("errors: facet array, error.class/error.message keys, count and a stable id", async () => {
    const q = queryOf(nerdgraph(standard).fetch);
    const groups = await q.errors!({ service: SERVICE, window: WINDOW, limit: 10 }, io());
    for (const g of groups) ErrorGroupSchema.parse(g);
    assert.deepEqual(groups.map((g) => [g.title, g.count]), [
      ["java.net.SocketTimeoutException: Read timed out calling payments-api", 412],
      ["java.lang.NullPointerException: cart.items is null", 37],
      ["IllegalStateException: ledger locked", 5],
    ]);
    assert.deepEqual(groups[0], {
      id: groups[0]!.id, title: "java.net.SocketTimeoutException: Read timed out calling payments-api", culprit: null, level: null, status: null,
      count: 412, userCount: null, firstSeen: null, lastSeen: null, release: null, url: null,
    });
    assert.match(groups[0]!.id, /^[0-9a-f]{16}$/);
    assert.equal(new Set(groups.map((g) => g.id)).size, 3);
    const again = await q.errors!({ service: SERVICE, window: WINDOW, limit: 10 }, io());
    assert.deepEqual(again.map((g) => g.id), groups.map((g) => g.id));
  });

  test("errors: scalar facet, missing count, limit and unreadable rows", async () => {
    const rows = [{ facet: "OnlyClass", count: 2 }, { facet: ["a", "b"] }, { facet: ["x"], count: -3 }, { count: 9 }, "junk", { facet: [], count: 1 }];
    const q = queryOf(nerdgraph(() => ({ body: response(rows) })).fetch);
    const groups = await q.errors!({ service: SERVICE, window: WINDOW, limit: 2 }, io());
    assert.deepEqual(groups.map((g) => [g.title, g.count]), [["OnlyClass", 2], ["a: b", null]]);
    const all = await q.errors!({ service: SERVICE, window: WINDOW, limit: 50 }, io());
    assert.deepEqual(all.map((g) => g.title), ["OnlyClass", "a: b", "x"]);
  });

  test("errors: vendor text is sanitized and clipped", async () => {
    const rows = [{ facet: ["Boom\u0000 <<<x>>>", "m".repeat(900)], count: 1 }];
    const q = queryOf(nerdgraph(() => ({ body: response(rows) })).fetch);
    const [g] = await q.errors!({ service: SERVICE, window: WINDOW, limit: 5 }, io());
    assert.ok(!g!.title.includes("<<<") && !g!.title.includes("\u0000"));
    ErrorGroupSchema.parse(g);
  });

  test("logs: rows become entries with a normalized level and the requested limit", async () => {
    const { fetch, calls } = nerdgraph(standard);
    const q = queryOf(fetch);
    const logs = await q.logs!({ service: SERVICE, level: "ERROR", window: WINDOW, limit: 2 }, io());
    for (const l of logs) LogEntrySchema.parse(l);
    assert.deepEqual(logs, [
      { ts: "2026-10-04T09:42:30.000Z", level: "ERROR", message: "payments-api call failed: Read timed out", count: 1 },
      { ts: "2026-10-04T09:42:20.000Z", level: "ERROR", message: "payments-api call failed: Read timed out", count: 1 },
    ]);
    const nrql = JSON.parse(calls[0]!.body!).variables.nrql as string;
    assert.match(nrql, /FROM Log WHERE service\.name = 'Checkout API \(prod\)' AND level = 'ERROR'/);
    assert.match(nrql, /LIMIT 2$/);
    const warn = await q.logs!({ service: SERVICE, level: "WARN", window: WINDOW, limit: 10 }, io());
    assert.equal(warn.at(-1)!.level, "WARN");
    assert.match(JSON.parse(calls[1]!.body!).variables.nrql, /level = 'WARN'/);
  });

  test("logs: level names are mapped (WARNING, FATAL) and an unknown level takes the requested one", async () => {
    const rows = [
      { timestamp: 1791106950000, level: "WARNING", message: "a" }, { timestamp: 1791106950000, level: "fatal", message: "b" },
      { timestamp: 1791106950000, level: "weird", message: "c" }, { timestamp: 1791106950000, message: "d" },
      { timestamp: "nope", level: "ERROR", message: "e" }, { timestamp: 1791106950000, level: "ERROR" }, "junk",
    ];
    const q = queryOf(nerdgraph(() => ({ body: response(rows) })).fetch);
    const logs = await q.logs!({ service: SERVICE, level: "ERROR", window: WINDOW, limit: 10 }, io());
    assert.deepEqual(logs.map((l) => [l.message, l.level]), [["a", "WARN"], ["b", "ERROR"], ["c", "ERROR"], ["d", "ERROR"]]);
  });

  test("deploys: rows become records, newest first, and only those since the requested time", async () => {
    const { fetch, calls } = nerdgraph(standard);
    const q = queryOf(fetch);
    const since = new Date("2026-10-03T00:00:00.000Z");
    const d = await q.deploys!({ service: SERVICE, since }, io());
    for (const r of d) DeployRecordSchema.parse(r);
    assert.deepEqual(d, [
      { version: "2026.10.04-1", at: "2026-10-04T09:10:00.000Z", environment: null, author: "ci-bot", description: "Release 2026.10.04-1", url: null },
      { version: "2026.10.03-4", at: "2026-10-04T05:00:00.000Z", environment: null, author: "ci-bot", description: "Release 2026.10.03-4", url: null },
    ].filter((x) => Date.parse(x.at) >= since.getTime()));
    assert.match(JSON.parse(calls[0]!.body!).variables.nrql, new RegExp(`SINCE ${since.getTime()} LIMIT 10$`));
    const later = await q.deploys!({ service: SERVICE, since: new Date("2026-10-04T08:00:00.000Z") }, io());
    assert.deepEqual(later.map((r) => r.version), ["2026.10.04-1"]);
  });

  test("logs and deploys set to null are not offered; errors null too", () => {
    const off = queryOf(nerdgraph(standard).fetch, { nrql: { logs: null, deploys: null } });
    assert.equal(off.logs, undefined);
    assert.equal(off.deploys, undefined);
    assert.ok(off.errors);
    assert.ok(off.metrics);
    const none = queryOf(nerdgraph(standard).fetch, { nrql: { errors: null } });
    assert.equal(none.errors, undefined);
    assert.ok(none.logs && none.deploys);
    assert.equal(none.external, undefined);
  });

  test("an unsafe service name never reaches the network", async () => {
    const { fetch, calls } = nerdgraph(standard);
    const q = queryOf(fetch);
    await assert.rejects(q.metrics!({ service: "x' OR 1=1 --", metric: "error_rate", window: WINDOW }, io()), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input");
    await assert.rejects(q.errors!({ service: "x\nSINCE 1", window: WINDOW, limit: 5 }, io()), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input");
    await assert.rejects(q.logs!({ service: "a'b", level: "WARN", window: WINDOW, limit: 5 }, io()), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input");
    await assert.rejects(q.deploys!({ service: "a=b", since: WINDOW.from }, io()), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input");
    assert.equal(calls.length, 0);
  });

  test("a bad level or limit from a caller is refused, not rendered", async () => {
    const q = queryOf(nerdgraph(standard).fetch);
    await assert.rejects(q.logs!({ service: SERVICE, level: "INFO" as "ERROR", window: WINDOW, limit: 5 }, io()), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input");
  });

  test("malformed responses become bad_response", async () => {
    const cases: unknown[] = [
      fixture("nerdgraph-graphql-error.json"),
      { errors: [{ message: "x" }] },
      {},
      { data: null },
      { data: { actor: null } },
      { data: { actor: { account: { nrql: { results: "nope" } } } } },
      { data: { actor: { account: { nrql: { results: { a: 1 } } } } } },
      { data: { actor: { account: { nrql: null } } } },
      "not an object",
      [],
    ];
    for (const body of cases) {
      const q = queryOf(nerdgraph(() => ({ body })).fetch);
      for (const call of [
        () => q.metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io()),
        () => q.errors!({ service: SERVICE, window: WINDOW, limit: 5 }, io()),
        () => q.logs!({ service: SERVICE, level: "ERROR", window: WINDOW, limit: 5 }, io()),
        () => q.deploys!({ service: SERVICE, since: WINDOW.from }, io()),
      ]) {
        await assert.rejects(call(), (e: unknown) => e instanceof ConnectorError && e.kind === "bad_response", JSON.stringify(body));
      }
    }
  });

  test("an empty errors array with data is fine; empty results give empty answers", async () => {
    const q = queryOf(nerdgraph(() => ({ body: { errors: [], ...response([]) } })).fetch);
    assert.deepEqual(await q.errors!({ service: SERVICE, window: WINDOW, limit: 5 }, io()), []);
    assert.deepEqual(await q.logs!({ service: SERVICE, level: "ERROR", window: WINDOW, limit: 5 }, io()), []);
    assert.deepEqual(await q.deploys!({ service: SERVICE, since: WINDOW.from }, io()), []);
    assert.deepEqual(await q.metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io()), { metric: "error_rate", unit: null, points: [] });
  });

  test("HTTP failures map through the shared client and carry no secret", async () => {
    const expectations: [number, string][] = [[401, "auth"], [403, "auth"], [429, "rate_limited"], [503, "unavailable"], [400, "bad_response"]];
    for (const [status, kind] of expectations) {
      const q = queryOf(nerdgraph(() => ({ status, body: { error: `key ${API_KEY} rejected` }, headers: { "retry-after": "12" } })).fetch);
      await assert.rejects(q.metrics!({ service: SERVICE, metric: "error_rate", window: WINDOW }, io()), (e: unknown) => {
        assert.ok(e instanceof ConnectorError);
        assert.equal(e.kind, kind);
        if (kind === "rate_limited") assert.equal(e.retryAfterSec, 12);
        assert.equal(`${e.message} ${e.stack}`.includes(API_KEY), false);
        return true;
      });
    }
  });

  test("the caller's abort signal reaches the request", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchFn = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(init.signal);
      return new Response(JSON.stringify(response([])), { status: 200 });
    }) as typeof fetch;
    const ac = new AbortController();
    await queryOf(fetchFn).errors!({ service: SERVICE, window: WINDOW, limit: 5 }, { signal: ac.signal, now: NOW });
    ac.abort();
    assert.equal(seen[0]!.aborted, true, "the request signal follows the caller's");
  });
});
