// Slack notifier (spec 008, AC-56; docs/connectors/slack.md): the shared conformance kit, a golden body, the escaping
// and clipping rules of the renderer and the mapping of Slack's plain-text answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { slackNotifier } from "../../src/notifiers/slack/index.ts";
import { renderSlack } from "../../src/notifiers/slack/render.ts";
import type { NotificationMessage, NotifyOutcome } from "../../src/notifiers/types.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { describeNotifierConformance } from "../helpers/notifier-conformance.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import type { FakeRoute } from "../helpers/fake-fetch.ts";
import { sampleNotificationMessage } from "../helpers/notifications.ts";

const URL_SECRET = "https://hooks.slack.com/services/" + "T0A1B2C3D/B0E1F2G3H/" + "x".repeat(24);

describeNotifierConformance(slackNotifier, {
  env: { SLACK_WEBHOOK_URL: URL_SECRET },
  entry: { webhookUrl: "${SLACK_WEBHOOK_URL}", events: ["analysis_ready"] },
  secrets: [URL_SECRET],
  okRoutes: [{ method: "POST", url: URL_SECRET, status: 200, body: "ok" }],
  failureRoutes: (kind) => [kind === "retryable" ? { method: "POST", url: URL_SECRET, status: 503, body: "upstream" } : { method: "POST", url: URL_SECRET, status: 404, body: "no_service" }],
});

type Built = { notifier: ReturnType<typeof slackNotifier.create>; calls: ReturnType<typeof createFakeFetch>["calls"] };

function parseEntry(entry: Record<string, unknown>, env: Record<string, string> = { SLACK_WEBHOOK_URL: URL_SECRET }) {
  const text = JSON.stringify({ version: 1, notifiers: [{ id: "chat", type: "slack", ...entry }] });
  return parseCopilotConfig(text, { format: "json", env, connectors: [], notifiers: [slackNotifier] });
}

function build(routes: FakeRoute[], entry: Record<string, unknown> = { webhookUrl: "${SLACK_WEBHOOK_URL}" }): Built {
  const r = parseEntry(entry);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const { fetch, calls } = createFakeFetch(routes);
  const notifier = slackNotifier.create(r.config.notifiers[0]!.config, {
    id: "chat",
    http: createHttpClient({ fetch }),
    logger: createLogger({ level: "error", secrets: [URL_SECRET], write: () => {} }),
  });
  return { notifier, calls };
}

const signal = () => new AbortController().signal;
const send = (b: Built, m: NotificationMessage = sampleNotificationMessage()): Promise<NotifyOutcome> => b.notifier.send(m, { signal: signal() });
const okRoute: FakeRoute = { method: "POST", url: URL_SECRET, status: 200, body: "ok" };

// Every text of a rendered message, with the block type it sits in.
function texts(m: ReturnType<typeof renderSlack>): { where: "section" | "field" | "context"; text: string }[] {
  const out: { where: "section" | "field" | "context"; text: string }[] = [];
  for (const b of m.blocks) {
    if (b.type === "section") {
      if (b.text) out.push({ where: "section", text: b.text.text });
      for (const f of b.fields ?? []) out.push({ where: "field", text: f.text });
    } else for (const e of b.elements) out.push({ where: "context", text: e.text });
  }
  return out;
}

test("the request is a JSON POST to the webhook URL and matches the golden body", async () => {
  const b = build([okRoute]);
  assert.deepEqual(await send(b), { ok: true });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0]!.method, "POST");
  assert.equal(b.calls[0]!.url, URL_SECRET);
  assert.match(b.calls[0]!.headers["content-type"]!, /^application\/json/);
  assert.deepEqual(JSON.parse(b.calls[0]!.body!), JSON.parse(readFileSync("tests/fixtures/notifiers/slack-analysis-ready.json", "utf8")));
});

test("the text fallback names the kind, the severity, the title and the service", () => {
  const base = { title: "Disk full", service: "billing", severity: "sev1" } as const;
  const text = (kind: NotificationMessage["kind"]) => renderSlack(sampleNotificationMessage({ ...base, kind })).text;
  assert.equal(text("incident_opened"), "[SEV1] Incident opened: Disk full (billing)");
  assert.equal(text("analysis_ready"), "[SEV1] Analysis ready: Disk full (billing)");
  assert.equal(text("run_failed"), "[SEV1] Run failed: Disk full (billing)");
  assert.equal(text("incident_resolved"), "[SEV1] Resolved: Disk full (billing)");
  assert.equal(renderSlack(sampleNotificationMessage({ ...base, service: null })).text, "[SEV1] Analysis ready: Disk full");
});

test("&, < and > are escaped in every text from the message and a mention cannot be injected", () => {
  const evil = "<!channel> & <script>";
  const m = sampleNotificationMessage({
    title: evil,
    service: evil,
    diagnosis: { category: evil, confidence: evil, hypothesis: evil },
    recommendations: [{ order: 1, actionType: evil, target: evil, tier: 3, status: "recommended" }],
    source: { connectorId: evil, type: evil, url: null },
  });
  const r = renderSlack(m);
  const all = [r.text, ...texts(r).map((t) => t.text)];
  for (const t of all) {
    assert.doesNotMatch(t.replace(/<https?:[^>]*>/g, ""), /[<>]/, "no raw angle bracket outside our own links");
    assert.doesNotMatch(t, /&(?!amp;|lt;|gt;)/);
  }
  assert.ok(r.text.includes("&lt;!channel&gt; &amp; &lt;script&gt;"));
  assert.ok(!JSON.stringify(r).includes("<!channel>"));
});

test("links: only http(s) URLs, with | and > removed; anything else is dropped", () => {
  const link = (url: string | null, incident: string | null = null) =>
    texts(renderSlack(sampleNotificationMessage({ source: { connectorId: "prom", type: "alertmanager", url }, links: { incident } }))).filter((t) => t.text.includes("<http"));
  const [hit] = link("https://prom.example.com/graph?a=1&b=2|x>y");
  assert.ok(hit);
  assert.match(hit.text, /<https:\/\/prom\.example\.com\/graph\?a=1&amp;b=2xy\|[^<>|]+>/);
  assert.equal(link("javascript:alert(1)").length, 0);
  assert.equal(link("data:text/html,<b>x</b>").length, 0);
  assert.equal(link("not a url").length, 0);
  assert.equal(link(null).length, 0);
  assert.equal(link("ftp://files.example.com/x").length, 0);
  assert.ok(link(null, "http://localhost:3000/incidents/INC-0001")[0]!.text.includes("<http://localhost:3000/incidents/INC-0001|"));
});

test("recommendations: one line per item with its catalog tier, never claiming execution", () => {
  const rec = (order: number, actionType: string, tier: 1 | 2 | 3 | 4, status: string) => ({ order, actionType, target: `t/${order}`, tier, status });
  const r = renderSlack(sampleNotificationMessage({ recommendations: [rec(2, "b", 2, "recommended"), rec(1, "a", 3, "recommended"), rec(3, "c", 4, "blocked_forbidden"), rec(4, "d", 3, "blocked_unknown")] }));
  const block = texts(r).find((t) => t.text.startsWith("*Recommendations*"))!;
  assert.deepEqual(block.text.split("\n").slice(1), [
    "Tier 3 - a on t/1 - recommended, not executed (would require human approval)",
    "Tier 2 - b on t/2 - recommended, not executed (shadow mode)",
    "Tier 4 - c on t/3 - blocked (forbidden by construction)",
    "Tier 3 - d on t/4 - blocked (not in the catalog)",
  ]);
  assert.ok(texts(r).some((t) => t.where === "context" && t.text === "Shadow mode: nothing was executed."));
});

test("recommendations: at most 10 lines plus the count of the rest; none means no block", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ order: i + 1, actionType: "add_incident_note", target: `incident/s${i}`, tier: 2 as const, status: "recommended" }));
  const block = texts(renderSlack(sampleNotificationMessage({ recommendations: many }))).find((t) => t.text.startsWith("*Recommendations*"))!;
  const lines = block.text.split("\n").slice(1);
  assert.equal(lines.length, 11);
  assert.equal(lines[10], "(4 more)");
  assert.ok(lines[9]!.includes("incident/s9") && !block.text.includes("incident/s10"));
  assert.ok(!texts(renderSlack(sampleNotificationMessage({ recommendations: [] }))).some((t) => t.text.startsWith("*Recommendations*")));
  assert.ok(!texts(renderSlack(sampleNotificationMessage({ diagnosis: null }))).some((t) => t.text.startsWith("*Diagnosis*")));
});

test("limits: sections stay within 3000 characters, fields within 2000, at most 10 fields and 10 blocks", () => {
  const big = "&<>".repeat(3000);
  const m = sampleNotificationMessage({
    title: big,
    service: big,
    diagnosis: { category: big, confidence: big, hypothesis: big },
    recommendations: Array.from({ length: 40 }, (_, i) => ({ order: i + 1, actionType: big, target: big, tier: 3 as const, status: "recommended" })),
    source: { connectorId: big, type: big, url: `https://example.com/${"a".repeat(5000)}` },
    links: { incident: `https://example.com/${"b".repeat(5000)}` },
  });
  const r = renderSlack(m);
  assert.ok(r.blocks.length <= 10);
  assert.ok(r.text.length > 0 && r.text.length <= 3000);
  for (const t of texts(r)) {
    assert.ok(t.text.length >= 1);
    assert.ok(t.text.length <= (t.where === "field" ? 2000 : 3000), `${t.where} of ${t.text.length} characters`);
    assert.doesNotMatch(t.text.replace(/<https?:[^>]*>/g, ""), /&(?!amp;|lt;|gt;)|&(a|am|amp|l|lt|g|gt)$/, "an escape is never cut in half");
  }
  for (const b of r.blocks) if (b.type === "section" && b.fields) assert.ok(b.fields.length <= 10);
  assert.ok(JSON.stringify(r).length < 40_000);
});

test("answers: 200 ok is success; 429 is retryable with Retry-After; 5xx and network failures are retryable", async () => {
  assert.deepEqual(await send(build([okRoute])), { ok: true });
  assert.deepEqual(await send(build([{ method: "POST", url: URL_SECRET, status: 429, headers: { "retry-after": "7" }, body: "rate_limited" }])), { ok: false, retryable: true, retryAfterSec: 7, reason: "rate limited" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL_SECRET, status: 429, body: "" }])), { ok: false, retryable: true, retryAfterSec: null, reason: "rate limited" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL_SECRET, status: 500, body: "boom" }])), { ok: false, retryable: true, retryAfterSec: null, reason: "http 500" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL_SECRET, status: 503, headers: { "retry-after": "2" }, body: "" }])), { ok: false, retryable: true, retryAfterSec: 2, reason: "http 503" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL_SECRET, error: "network" }])), { ok: false, retryable: true, retryAfterSec: null, reason: "unavailable" });
});

test("answers: Slack's known error strings are permanent and reported by code", async () => {
  const known: [number, string][] = [
    [400, "invalid_payload"], [400, "no_text"], [404, "no_service"], [404, "no_service_id"], [403, "no_active_hooks"], [403, "invalid_token"],
    [403, "action_prohibited"], [404, "channel_is_archived"], [404, "channel_not_found"], [404, "user_not_found"], [403, "no_team"],
    [403, "team_disabled"], [403, "posting_to_general_channel_denied"], [400, "too_many_attachments"],
  ];
  for (const [status, code] of known) {
    assert.deepEqual(await send(build([{ method: "POST", url: URL_SECRET, status, body: code + "\n" }])), { ok: false, retryable: false, retryAfterSec: null, reason: code }, code);
  }
});

test("answers: an unknown 4xx text is 'rejected' and never echoed; a 200 that is not 'ok' is not success", async () => {
  const echo = "something went wrong with " + URL_SECRET;
  const out = await send(build([{ method: "POST", url: URL_SECRET, status: 400, body: echo }]));
  assert.deepEqual(out, { ok: false, retryable: false, retryAfterSec: null, reason: "rejected" });
  const odd = await send(build([{ method: "POST", url: URL_SECRET, status: 200, body: "<html>captive portal</html>" }]));
  assert.ok(!odd.ok && !odd.retryable);
  assert.ok(!JSON.stringify(odd).includes("captive"));
});

test("no outcome carries the webhook URL or any part of it", async () => {
  const routes: FakeRoute[][] = [
    [{ method: "POST", url: URL_SECRET, status: 400, body: URL_SECRET }],
    [{ method: "POST", url: URL_SECRET, status: 500, body: URL_SECRET }],
    [{ method: "POST", url: URL_SECRET, error: "network" }],
    [{ method: "POST", url: URL_SECRET, status: 200, body: URL_SECRET }],
  ];
  for (const r of routes) {
    const text = JSON.stringify(await send(build(r)));
    assert.ok(!text.includes("x".repeat(24)) && !text.includes("hooks.slack.com") && !text.includes("T0A1B2C3D"));
  }
});

test("the caller's abort signal ends the send", async () => {
  const b = build([{ ...okRoute, delayMs: 5000 }]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  const out = await b.notifier.send(sampleNotificationMessage(), { signal: ac.signal });
  assert.equal(out.ok, false);
});

test("config: the URL must be a Slack incoming-webhook URL unless its host is listed in allowedHosts", () => {
  const bad = parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}" }, { SLACK_WEBHOOK_URL: "https://evil.example.com/services/" + "a".repeat(30) });
  assert.ok(!bad.ok);
  assert.ok(!bad.ok && bad.problems.some((p) => p.path.includes("webhookUrl")));
  assert.ok(!JSON.stringify(bad).includes("evil.example.com"), "the rejected value is never echoed");

  const http = parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}" }, { SLACK_WEBHOOK_URL: "http://hooks.slack.com/services/" + "a".repeat(30) });
  assert.ok(!http.ok);

  const noPath = parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}" }, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/" + "a".repeat(30) });
  assert.ok(!noPath.ok);

  const gov = "https://hooks.slack-gov.example/services/" + "a".repeat(30);
  assert.ok(parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}", allowedHosts: ["hooks.slack-gov.example"] }, { SLACK_WEBHOOK_URL: gov }).ok);
  assert.ok(!parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}", allowedHosts: ["other.example"] }, { SLACK_WEBHOOK_URL: gov }).ok);
  const httpGov = "http://hooks.slack-gov.example/services/" + "a".repeat(30);
  assert.ok(!parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}", allowedHosts: ["hooks.slack-gov.example"] }, { SLACK_WEBHOOK_URL: httpGov }).ok);
});

test("config: strict keys, a whole ${VAR} reference and at least 30 characters", () => {
  assert.ok(!parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}", channel: "#ops" }).ok, "channel cannot be overridden");
  assert.ok(!parseEntry({ webhookUrl: URL_SECRET }).ok, "a literal URL is refused");
  assert.ok(!parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}" }, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" }).ok, "too short");
  assert.ok(!parseEntry({}).ok);
  assert.ok(!parseEntry({ webhookUrl: "${SLACK_WEBHOOK_URL}", allowedHosts: ["https://has-scheme.example"] }).ok);
});

// ---------- code-fix messages (spec 009, AC-83) ----------

function codeFixFacts(over: Partial<NonNullable<NotificationMessage["codeFix"]>> = {}): NonNullable<NotificationMessage["codeFix"]> {
  return {
    attemptId: "fix_0123456789abcdef", status: "awaiting_approval", mode: "draft_pr", repo: "acme/checkout-web", baseBranch: "main",
    location: { file: "src/checkout/cart-summary.ts", line: 12 }, exceptionType: "TypeError",
    diff: { added: 10, removed: 1, files: 2 }, testName: "summarize returns 0 for <empty> & missing totals",
    evidence: { failedBefore: true, passesAfter: true, suiteTotal: 4, suiteFailed: 0 },
    approval: { id: "APR-0007", expiresAt: "2026-10-07T10:04:00.000Z" }, pullRequest: null,
    links: { approval: "https://copilot.example.com/approvals?status=pending", pullRequest: null },
    ...over,
  };
}
const codeFixMessage = (over: Partial<NonNullable<NotificationMessage["codeFix"]>> = {}, kind: NotificationMessage["kind"] = "code_fix_ready") =>
  sampleNotificationMessage({ kind, codeFix: codeFixFacts(over) });

test("a code_fix_ready message matches its hand-written golden", async () => {
  assert.deepEqual(renderSlack(codeFixMessage()), JSON.parse(readFileSync("tests/fixtures/notifiers/slack-code-fix-ready.json", "utf8")));
  const b = build([okRoute]);
  assert.deepEqual(await send(b, codeFixMessage()), { ok: true });
  assert.deepEqual(JSON.parse(b.calls[0]!.body!), JSON.parse(readFileSync("tests/fixtures/notifiers/slack-code-fix-ready.json", "utf8")));
});

test("code-fix messages: the fallback names the kind; shadow and opened pull requests say what happened, never a merge", () => {
  const base = { title: "Disk full", service: "billing", severity: "sev1" } as const;
  assert.equal(renderSlack(sampleNotificationMessage({ ...base, kind: "code_fix_ready", codeFix: codeFixFacts() })).text, "[SEV1] Code fix ready: Disk full (billing)");
  assert.equal(renderSlack(sampleNotificationMessage({ ...base, kind: "code_fix_pr_opened", codeFix: codeFixFacts() })).text, "[SEV1] Draft pull request opened: Disk full (billing)");

  const shadow = texts(renderSlack(codeFixMessage({ status: "patch_ready", mode: "shadow", approval: null, links: { approval: null, pullRequest: null } })));
  const fixBlock = shadow.find((t) => t.text.startsWith("*Code fix*"))!;
  assert.ok(fixBlock.text.includes("Status: patch ready (shadow mode, not published)"));
  assert.ok(!fixBlock.text.includes("Approval"));
  assert.ok(shadow.some((t) => t.where === "context" && t.text === "Shadow mode: the fix was not published."));
  assert.ok(!shadow.some((t) => t.text.startsWith("*Recommendations*")), "a code-fix message does not repeat the incident's recommendations");

  const opened = texts(renderSlack(codeFixMessage({
    status: "pr_opened", approval: null, pullRequest: { number: 42, url: "https://github.com/acme/checkout-web/pull/42" },
    links: { approval: null, pullRequest: "https://github.com/acme/checkout-web/pull/42" },
  }, "code_fix_pr_opened")));
  const openedBlock = opened.find((t) => t.text.startsWith("*Code fix*"))!;
  assert.ok(openedBlock.text.includes("Status: draft pull request opened"));
  assert.ok(openedBlock.text.includes("Pull request: #42"));
  assert.ok(opened.some((t) => t.where === "context" && t.text === "Draft pull request opened after human approval; it is never merged."));
  assert.ok(opened.some((t) => t.text.includes("<https://github.com/acme/checkout-web/pull/42|Draft pull request #42>")));
});

test("code-fix messages: the weak evidence, a missing location and a single file are stated plainly; every text is escaped", () => {
  const evil = "<!channel> & <script>";
  const r = renderSlack(codeFixMessage({
    repo: evil, baseBranch: evil, location: null, exceptionType: evil, testName: evil, diff: { added: 1, removed: 0, files: 1 },
    evidence: { failedBefore: false, passesAfter: false, suiteTotal: 4, suiteFailed: 1 },
  }));
  const block = texts(r).find((t) => t.text.startsWith("*Code fix*"))!;
  assert.ok(block.text.includes("Location: unknown"));
  assert.ok(block.text.includes("Diff: +1 -0 in 1 file\n"));
  assert.ok(block.text.includes("Evidence: did not fail before / does not pass after; suite 4 tests, 1 failed"));
  for (const t of [r.text, ...texts(r).map((x) => x.text)]) {
    assert.doesNotMatch(t.replace(/<https?:[^>]*>/g, ""), /[<>]/);
    assert.doesNotMatch(t, /&(?!amp;|lt;|gt;)/);
  }
  assert.ok(!JSON.stringify(r).includes("<!channel>"));
  const noTest = texts(renderSlack(codeFixMessage({ testName: null }))).find((t) => t.text.startsWith("*Code fix*"))!;
  assert.ok(noTest.text.includes("Regression test: -"));
});
