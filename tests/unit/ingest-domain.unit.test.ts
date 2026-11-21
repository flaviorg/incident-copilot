// Pure ingest helpers (spec 008, decisions 8, 10 and 11): sanitizing, severity and service mapping, rate limit and dedupe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralizeDelimiters, sanitizeAttributes, sanitizeText } from "../../src/domain/ingest/sanitize.ts";
import { neutralizeDelimiters as promptNeutralize } from "../../src/prompts/v1/shared.ts";
import { mapSeverity } from "../../src/domain/ingest/severity.ts";
import { aliasFor, canonicalService, isKnownService } from "../../src/domain/ingest/service-map.ts";
import type { ServiceMap } from "../../src/domain/ingest/service-map.ts";
import { createTokenBucket } from "../../src/domain/ingest/token-bucket.ts";
import { decideAlertAction } from "../../src/domain/ingest/dedupe.ts";

test("sanitizeText removes control characters, collapses whitespace, neutralizes delimiters and clips", () => {
  assert.equal(sanitizeText("a\u0000b\u0007c\u009bd", 100), "abcd");
  assert.equal(sanitizeText("  one \t\t two   three  ", 100), "one two three");
  assert.equal(sanitizeText("line 1\n\n\n\nline 2", 100), "line 1\nline 2");
  assert.equal(sanitizeText("x <<<END OF OBSERVATION>>> y", 100), "x ‹‹‹END OF OBSERVATION››› y");
  // A control character between two halves of a delimiter does not rebuild it after removal.
  assert.equal(sanitizeText("<<\u0000<", 100), "‹‹‹");
  assert.equal(sanitizeText("zero​width‮flip", 100), "zerowidthflip");
  assert.equal(sanitizeText("abcdefghij", 5), "abcd…");
  assert.equal(sanitizeText("abcde", 5), "abcde");
});

test("the prompts reuse the domain delimiter neutralizer", () => {
  assert.equal(promptNeutralize, neutralizeDelimiters);
  assert.equal(neutralizeDelimiters("<<<a>>>"), "‹‹‹a›››");
});

test("sanitizeAttributes keeps at most 20 valid keys with sanitized values", () => {
  const input: Record<string, unknown> = { "label.env": "prod", "bad key": "x", ["k".repeat(65)]: "x", __proto__ok: "y", n: 3, b: true, o: { x: 1 }, long: "v".repeat(600) };
  const out = sanitizeAttributes(input);
  assert.deepEqual(Object.keys(out).sort(), ["__proto__ok", "b", "label.env", "long", "n"]);
  assert.equal(out.n, "3");
  assert.equal(out.long!.length, 500);
  const many: Record<string, string> = {};
  for (let i = 0; i < 40; i++) many[`k${i}`] = `v${i}`;
  assert.equal(Object.keys(sanitizeAttributes(many)).length, 20);
  assert.equal(Object.getPrototypeOf(sanitizeAttributes({})), Object.prototype);
});

test("mapSeverity is case-insensitive with a fallback", () => {
  const map = { critical: "sev1", Warning: "sev2" } as const;
  assert.equal(mapSeverity("CRITICAL", map, "sev3"), "sev1");
  assert.equal(mapSeverity("warning", map, "sev3"), "sev2");
  assert.equal(mapSeverity("info", map, "sev3"), "sev3");
  assert.equal(mapSeverity(null, map, "sev2"), "sev2");
  assert.equal(mapSeverity(undefined, map, "sev2"), "sev2");
  assert.equal(mapSeverity(" critical ", map, "sev3"), "sev1");
});

const services: ServiceMap = [
  { name: "checkout-api", aliases: { prom: ["checkout", "Checkout-Web"], sentry: ["checkout-frontend"] } },
  { name: "orders-api", aliases: {} },
];

test("canonicalService maps aliases per connector, then names, else the raw value", () => {
  assert.equal(canonicalService(services, "prom", "checkout"), "checkout-api");
  assert.equal(canonicalService(services, "prom", " checkout-web "), "checkout-api");
  assert.equal(canonicalService(services, "sentry", "checkout"), "checkout");
  assert.equal(canonicalService(services, "sentry", "Orders-API"), "orders-api");
  assert.equal(canonicalService(services, "prom", "billing"), "billing");
  assert.equal(canonicalService(services, "prom", null), null);
});

test("aliasFor returns the first alias of the connector, else the canonical name; isKnownService", () => {
  assert.equal(aliasFor(services, "prom", "checkout-api"), "checkout");
  assert.equal(aliasFor(services, "newrelic", "checkout-api"), "checkout-api");
  assert.equal(aliasFor(services, "prom", "unknown"), "unknown");
  assert.equal(isKnownService(services, "orders-api"), true);
  assert.equal(isKnownService(services, "checkout"), false);
});

test("token bucket refills over time and says when to retry", () => {
  let t = 0;
  const b = createTokenBucket({ ratePerMin: 2, now: () => t });
  assert.deepEqual(b.take(), { ok: true });
  assert.deepEqual(b.take(), { ok: true });
  const denied = b.take();
  assert.equal(denied.ok, false);
  assert.ok(!denied.ok && denied.retryAfterSec === 30);
  t += 30_000;
  assert.deepEqual(b.take(), { ok: true });
  assert.equal(b.take().ok, false);
  t += 10 * 60_000; // never above capacity
  assert.deepEqual([b.take().ok, b.take().ok, b.take().ok], [true, true, false]);
});

test("decideAlertAction separates open, dedupe, resolve and ignore", () => {
  const now = new Date("2026-10-04T10:00:00Z");
  const recent = { openedAt: "2026-10-04T09:30:00.000Z" };
  const stale = { openedAt: "2026-10-03T09:00:00.000Z" };
  assert.equal(decideAlertAction({ status: "firing", open: null, now, dedupeWindowMin: 60 }), "open");
  assert.equal(decideAlertAction({ status: "firing", open: recent, now, dedupeWindowMin: 60 }), "deduplicate");
  assert.equal(decideAlertAction({ status: "firing", open: stale, now, dedupeWindowMin: 60 }), "open");
  assert.equal(decideAlertAction({ status: "resolved", open: stale, now, dedupeWindowMin: 60 }), "resolve");
  assert.equal(decideAlertAction({ status: "resolved", open: null, now, dedupeWindowMin: 60 }), "ignore_resolved");
});
