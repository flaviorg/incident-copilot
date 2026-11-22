import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodeFixReason } from "../../src/contracts/index.ts";
import { evaluateEligibility, parseIssueFingerprint, type EligibilityInput } from "../../src/domain/code-fix/eligibility.ts";
import { CodeFixReasonSchema } from "../../src/contracts/index.ts";
import { isTransientReason, SKIP_REASONS, TRANSIENT_REASONS } from "../../src/domain/code-fix/reasons.ts";

type Usage = { attemptsLast24h: number; groupAttempts: number; keyHeld: boolean };

function base(usage: Partial<Usage> = {}): EligibilityInput {
  const u: Usage = { attemptsLast24h: 0, groupAttempts: 0, keyHeld: false, ...usage };
  return {
    status: "advised",
    escalation: null,
    origin: {
      kind: "connector", connectorId: "sentry", source: "sentry", fingerprint: "issue:4242", alertId: "ing_1",
      externalUrl: null, mode: "shadow",
    },
    diagnosis: { category: "bad_deploy", confidence: "high" },
    service: "checkout-web",
    repositories: [
      { repo: "acme/checkout-web", service: "checkout-web", connector: "sentry" },
      { repo: "acme/orders", service: "orders-api", connector: "sentry" },
    ],
    connectors: {
      sentry: { errorEvent: true, releaseCommit: true, deploys: true },
      bugsnag: { errorEvent: false, releaseCommit: false, deploys: true },
    },
    sandboxAvailable: true,
    limits: { maxAttemptsPerDay: 5, maxAttemptsPerGroup: 3 },
    usage: {
      attemptsLast24h: () => u.attemptsLast24h,
      group: () => ({ attempts: u.groupAttempts, keyHeld: u.keyHeld }),
    },
  };
}

function withOrigin(patch: Partial<NonNullable<EligibilityInput["origin"]>>): EligibilityInput {
  const b = base();
  return { ...b, origin: { ...b.origin!, ...patch } };
}

const SKIPS: ReadonlyArray<[name: string, input: EligibilityInput, reason: CodeFixReason]> = [
  ["status resolved", { ...base(), status: "resolved" }, "not_advised"],
  ["status investigating", { ...base(), status: "investigating" }, "not_advised"],
  ["status awaiting_approval", { ...base(), status: "awaiting_approval" }, "not_advised"],
  ["status escalated", { ...base(), status: "escalated" }, "not_advised"],
  ["advised but escalated", { ...base(), escalation: { reason: "low_confidence_diagnosis", detail: "x" } }, "not_advised"],
  ["scenario incident (no origin)", { ...base(), origin: undefined }, "source_unsupported"],
  ["scenario incident (null origin)", { ...base(), origin: null }, "source_unsupported"],
  ["bugsnag source", withOrigin({ source: "bugsnag", connectorId: "bugsnag" }), "source_unsupported"],
  ["metric alert fingerprint", withOrigin({ fingerprint: "metric:http_5xx_rate:checkout-web" }), "source_unsupported"],
  ["fingerprint with suffix", withOrigin({ fingerprint: "issue:4242:extra" }), "source_unsupported"],
  ["fingerprint id too long", withOrigin({ fingerprint: `issue:${"1".repeat(21)}` }), "source_unsupported"],
  ["fingerprint non-numeric", withOrigin({ fingerprint: "issue:abc" }), "source_unsupported"],
  ["no diagnosis", { ...base(), diagnosis: null }, "category_not_code"],
  ["config_error", { ...base(), diagnosis: { category: "config_error", confidence: "high" } }, "category_not_code"],
  ["resource_leak", { ...base(), diagnosis: { category: "resource_leak", confidence: "high" } }, "category_not_code"],
  ["unknown category", { ...base(), diagnosis: { category: "unknown", confidence: "medium" } }, "category_not_code"],
  ["low confidence", { ...base(), diagnosis: { category: "bad_deploy", confidence: "low" } }, "low_confidence"],
  ["service not allowlisted", { ...base(), service: "billing-api" }, "service_not_allowlisted"],
  ["null service", { ...base(), service: null }, "service_not_allowlisted"],
  [
    "service maps to two repositories",
    { ...base(), repositories: [...base().repositories, { repo: "acme/checkout-web-2", service: "checkout-web", connector: "sentry" }] },
    "service_not_allowlisted",
  ],
  [
    "connector without errorEvent",
    { ...base(), connectors: { sentry: { errorEvent: false, releaseCommit: true, deploys: true } } },
    "connector_unsupported",
  ],
  [
    "connector without releaseCommit",
    { ...base(), connectors: { sentry: { errorEvent: true, releaseCommit: false, deploys: true } } },
    "connector_unsupported",
  ],
  [
    "connector without deploys",
    { ...base(), connectors: { sentry: { errorEvent: true, releaseCommit: true, deploys: false } } },
    "connector_unsupported",
  ],
  ["connector missing", { ...base(), connectors: {} }, "connector_unsupported"],
  [
    "repository connector differs from the incident's connector",
    { ...base(), repositories: [{ repo: "acme/checkout-web", service: "checkout-web", connector: "sentry-eu" }],
      connectors: { sentry: { errorEvent: true, releaseCommit: true, deploys: true }, "sentry-eu": { errorEvent: true, releaseCommit: true, deploys: true } } },
    "connector_unsupported",
  ],
  ["sandbox unavailable", { ...base(), sandboxAvailable: false }, "sandbox_unavailable"],
  ["daily cap reached", base({ attemptsLast24h: 5 }), "daily_cap_reached"],
  ["daily cap exceeded", base({ attemptsLast24h: 9 }), "daily_cap_reached"],
  ["key held", base({ keyHeld: true, groupAttempts: 1 }), "already_attempted"],
  ["group attempts exhausted", base({ groupAttempts: 3 }), "already_attempted"],
  // Order (decision 4): the earliest failing check names the reason.
  ["resolved and low confidence", { ...base(), status: "resolved", diagnosis: { category: "bad_deploy", confidence: "low" } }, "not_advised"],
  ["bugsnag and config_error", { ...withOrigin({ source: "bugsnag" }), diagnosis: { category: "config_error", confidence: "high" } }, "source_unsupported"],
  ["config_error and unknown service", { ...base(), diagnosis: { category: "config_error", confidence: "low" }, service: "nope" }, "category_not_code"],
  ["low confidence and no sandbox", { ...base(), diagnosis: { category: "bad_deploy", confidence: "low" }, sandboxAvailable: false }, "low_confidence"],
  ["unknown service and no sandbox", { ...base(), service: "nope", sandboxAvailable: false }, "service_not_allowlisted"],
  ["no sandbox and cap reached", { ...base({ attemptsLast24h: 5, keyHeld: true }), sandboxAvailable: false }, "sandbox_unavailable"],
  ["cap reached and key held", base({ attemptsLast24h: 5, keyHeld: true }), "daily_cap_reached"],
];

test("at least 20 must-skip inputs", () => {
  assert.ok(SKIPS.length >= 20);
});

for (const [name, input, reason] of SKIPS) {
  test(`skip: ${name} -> ${reason}`, () => {
    assert.deepEqual(evaluateEligibility(input), { eligible: false, reason });
    assert.ok(SKIP_REASONS.includes(reason));
  });
}

test("exactly one eligible input", () => {
  assert.deepEqual(evaluateEligibility(base()), {
    eligible: true, repository: { repo: "acme/checkout-web", service: "checkout-web", connector: "sentry" }, errorGroupId: "4242",
  });
  const medium = { ...base(), diagnosis: { category: "bad_deploy" as const, confidence: "medium" as const } };
  assert.equal(evaluateEligibility(medium).eligible, true);
  assert.equal(evaluateEligibility(base({ attemptsLast24h: 4, groupAttempts: 2 })).eligible, true);
  const eligible = SKIPS.filter(([, i]) => evaluateEligibility(i).eligible);
  assert.equal(eligible.length, 0);
});

test("usage is not read when an earlier check fails", () => {
  let reads = 0;
  const input: EligibilityInput = {
    ...base(), sandboxAvailable: false,
    usage: { attemptsLast24h: () => (reads++, 0), group: () => (reads++, { attempts: 0, keyHeld: false }) },
  };
  assert.equal(evaluateEligibility(input).eligible, false);
  assert.equal(reads, 0);
});

test("usage is read for the resolved repository and error group", () => {
  const seen: string[] = [];
  const input: EligibilityInput = {
    ...base(),
    usage: {
      attemptsLast24h: (repo) => (seen.push(`day:${repo}`), 0),
      group: (repo, id) => (seen.push(`group:${repo}:${id}`), { attempts: 0, keyHeld: false }),
    },
  };
  assert.equal(evaluateEligibility(input).eligible, true);
  assert.deepEqual(seen, ["day:acme/checkout-web", "group:acme/checkout-web:4242"]);
});

test("parseIssueFingerprint", () => {
  assert.equal(parseIssueFingerprint("issue:1"), "1");
  assert.equal(parseIssueFingerprint(`issue:${"9".repeat(20)}`), "9".repeat(20));
  assert.equal(parseIssueFingerprint("issue:"), null);
  assert.equal(parseIssueFingerprint(" issue:1"), null);
  assert.equal(parseIssueFingerprint("issue:1\n"), null);
});

// ---------- reasons ----------

test("TRANSIENT_REASONS follow decision 16", () => {
  assert.deepEqual([...TRANSIENT_REASONS].sort(), [
    "attempt_timeout", "author_unavailable", "baseline_timeout", "codehost_error", "interrupted", "reviewer_unavailable",
    "sandbox_error", "workspace_failed",
  ]);
  for (const r of TRANSIENT_REASONS) assert.equal(isTransientReason(r), true);
  for (const r of ["guard_rejected", "reviewer_rejected", "repro_flaky", "already_attempted", "patch_mismatch"] as const) {
    assert.equal(isTransientReason(r), false);
  }
  assert.equal(isTransientReason(null), false);
});

test("SKIP_REASONS are the skip group of CodeFixReasonSchema and never transient", () => {
  const all = CodeFixReasonSchema.options;
  const skipGroup = all.slice(0, all.indexOf("commit_not_found") + 1);
  assert.deepEqual([...SKIP_REASONS], skipGroup);
  for (const r of SKIP_REASONS) assert.equal(isTransientReason(r), false);
});
