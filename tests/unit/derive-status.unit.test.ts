import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIncidentStatus } from "../../src/domain/status/derive-status.ts";
import { effectiveStatus, isExpired } from "../../src/domain/approval/approval-machine.ts";
import { bb, esc, pendingApproval, pm } from "../helpers/blackboard.ts";

test("effectiveStatus projects expiry without mutating", () => {
  const a = pendingApproval({ expiresAt: "2026-10-04T10:30:00.000Z" });
  assert.equal(effectiveStatus(a, new Date("2026-10-04T10:31:00Z")), "expired");
  assert.equal(a.status, "pending");
  assert.equal(effectiveStatus(a, new Date("2026-10-04T10:29:00Z")), "pending");
  assert.equal(isExpired(a, new Date("2026-10-04T10:30:00Z")), false);
  assert.equal(effectiveStatus({ ...a, status: "approved" }, new Date("2026-10-04T11:00:00Z")), "approved");
});

test("status table", () => {
  assert.equal(deriveIncidentStatus(bb({ escalation: esc() }), []), "escalated");
  assert.equal(deriveIncidentStatus(bb({ escalation: esc(), postmortem: pm("partial") }), []), "escalated");
  assert.equal(deriveIncidentStatus(bb({ postmortem: pm("final") }), []), "resolved");
  assert.equal(deriveIncidentStatus(bb({ phase: "awaiting_approval" }), ["pending"]), "awaiting_approval");
  assert.equal(deriveIncidentStatus(bb({ phase: "awaiting_approval" }), ["expired"]), "investigating");
  assert.equal(deriveIncidentStatus(bb({ phase: "executing" }), []), "mitigating");
  assert.equal(deriveIncidentStatus(bb({ phase: "verifying" }), []), "mitigating");
  assert.equal(deriveIncidentStatus(bb({ phase: "resume" }), ["approved"]), "mitigating");
  assert.equal(deriveIncidentStatus(bb({ phase: "new" }), []), "open");
  assert.equal(deriveIncidentStatus(bb({ phase: "planning" }), []), "investigating");
});
