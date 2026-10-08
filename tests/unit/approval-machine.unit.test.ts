import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveStatus, transition } from "../../src/domain/approval/approval-machine.ts";
import type { ApprovalEvent } from "../../src/domain/approval/approval-machine.ts";
import { ApprovalTransitionError } from "../../src/domain/errors.ts";
import type { Approval } from "../../src/contracts/index.ts";

const plusMin = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
function pending(o: { requestedAt: Date; ttlMin: number }): Approval {
  return {
    id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0002", status: "pending",
    requestedAt: o.requestedAt.toISOString(), expiresAt: plusMin(o.requestedAt, o.ttlMin).toISOString(),
    decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0,
  };
}
const approve = (approver: string, source: "structured" | "text" = "structured"): ApprovalEvent => ({ type: "approve", approver, comment: null, source });

const t0 = new Date("2026-10-04T10:00:00Z");
const a = pending({ requestedAt: t0, ttlMin: 30 });

test("approve before expiry", () => {
  const r = transition(a, approve("ana"), plusMin(t0, 5)) as Approval;
  assert.deepEqual([r.status, r.approver, r.decisionSource, r.version], ["approved", "ana", "structured", 1]);
  assert.equal(r.decidedAt, plusMin(t0, 5).toISOString());
  assert.equal(a.status, "pending"); // a entrada não muda
});

test("reject from text keeps the comment and the source", () => {
  const r = transition(a, { type: "reject", approver: "bia", comment: "risco alto", source: "text" }, plusMin(t0, 30)) as Approval;
  assert.deepEqual([r.status, r.approver, r.comment, r.decisionSource, r.version], ["rejected", "bia", "risco alto", "text", 1]);
});

test("approve after expiry is an expired error", () => assert.deepEqual(transition(a, approve("ana"), plusMin(t0, 31)), new ApprovalTransitionError("expired")));

test("expire event", () => {
  const r = transition(a, { type: "expire" }, plusMin(t0, 31)) as Approval;
  assert.deepEqual([r.status, r.decisionSource, r.approver, r.version], ["expired", "expiry", null, 1]);
  assert.equal(r.decidedAt, plusMin(t0, 31).toISOString());
});

test("any event on a decided approval is not_pending", () => {
  assert.deepEqual(transition({ ...a, status: "approved" }, approve("bia"), t0), new ApprovalTransitionError("not_pending"));
  for (const status of ["approved", "rejected", "expired"] as const) {
    assert.deepEqual(transition({ ...a, status }, { type: "expire" }, plusMin(t0, 40)), new ApprovalTransitionError("not_pending"), status);
  }
  // Decidir duas vezes não muda nada: a segunda transição falha sobre o resultado da primeira.
  const once = transition(a, approve("ana"), plusMin(t0, 1)) as Approval;
  assert.deepEqual(transition(once, { type: "reject", approver: "bia", comment: null, source: "structured" }, plusMin(t0, 2)), new ApprovalTransitionError("not_pending"));
});

test("effectiveStatus projects expiry without changing the object", () => {
  assert.equal(effectiveStatus(a, plusMin(t0, 31)), "expired");
  assert.equal(effectiveStatus(a, plusMin(t0, 30)), "pending");
  assert.equal(a.status, "pending");
});
