// Approval gate (spec 10.2, item 4): each step with its tier badge, who proposed it, who set its tier and who decides,
// the dry-run summary and the block reason. One Approve/Reject pair decides every pending approval in the batch and
// picks the recorded branch, after confirmation. Approve and Reject sit apart so neither is hit by accident.
import { useRef, useState } from "react";
import type { Approval, GatedAction } from "@contracts";
import { ACTION_STATUS_LABELS, APPROVAL_STATUS_LABELS } from "../labels.ts";
import { ApprovalDialog } from "./ApprovalDialog.tsx";
import { TierBadge } from "./TierBadge.tsx";

const BLOCKED: readonly GatedAction["status"][] = ["blocked_forbidden", "blocked_unknown"];

function statusText(a: GatedAction, approval: Approval | undefined): string {
  if (approval && approval.status !== "pending") return `${approval.id} ${APPROVAL_STATUS_LABELS[approval.status]} by a human`;
  if (a.status === "awaiting_approval" && approval) return `awaiting ${approval.id} (${APPROVAL_STATUS_LABELS[approval.status]})`;
  if (a.status === "ready") return "ready: runs after all decisions";
  if (BLOCKED.includes(a.status)) return "blocked without dry run";
  return ACTION_STATUS_LABELS[a.status];
}

function Authority({ a, approval }: { a: GatedAction; approval: Approval | undefined }) {
  const proposer = a.proposedBy === "mcp_client" ? { cls: "auth-system", text: "MCP client" } : { cls: "auth-model", text: "model" };
  const decider =
    a.tier === 4 || BLOCKED.includes(a.status)
      ? { cls: "is-off", text: "nobody" }
      : a.tier === 3
        ? { cls: "auth-human", text: approval && approval.status !== "pending" ? `human · ${APPROVAL_STATUS_LABELS[approval.status]}` : "a human" }
        : { cls: "auth-code", text: "code" };
  return (
    <dl className="authority">
      <div className={proposer.cls}>
        <dt>Proposed by</dt>
        <dd>{proposer.text}</dd>
      </div>
      <div className="auth-code">
        <dt>Tier set by</dt>
        <dd>catalog</dd>
      </div>
      <div className={decider.cls}>
        <dt>Decided by</dt>
        <dd>{decider.text}</dd>
      </div>
    </dl>
  );
}

export function ApprovalGate({ actions, approvals, onDecide }: {
  actions: GatedAction[];
  approvals: Approval[];
  onDecide?: (decision: "approve" | "reject") => void;
}) {
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const pending = approvals.filter((a) => a.status === "pending");
  const held = pending.length > 0 && onDecide !== undefined;
  const steps = [...actions].sort((x, y) => x.order - y.order);
  return (
    <section className={held ? "card gate is-held" : "card gate"} aria-labelledby="gate-title">
      <div className="card-head">
        <h2 id="gate-title" className="card-title" tabIndex={-1}>Approval gate</h2>
        {held ? <span className="gate-state">HELD · YOUR DECISION</span> : approvals.length > 0 && pending.length === 0 ? <span className="gate-state">DECIDED</span> : null}
      </div>
      <div className="card-body">
        <ol className="gate-steps">
          {steps.map((a) => {
            const approval = approvals.find((x) => x.id === a.approvalId);
            const compact = held && approval?.status !== "pending" && !BLOCKED.includes(a.status);
            if (compact) {
              return (
                <li key={a.id} className="gate-step is-compact">
                  <p className="gate-step-head">
                    <span className="step-order">{`Step ${a.order}`}</span> <code>{a.actionType}</code> <TierBadge tier={a.tier} />
                  </p>
                  <p className="step-status">{`${a.target} · ${a.tier === 4 ? "forbidden" : "code decides"} · ${statusText(a, approval)}`}</p>
                </li>
              );
            }
            return (
              <li key={a.id} className="gate-step">
                <p className="gate-step-head">
                  <span className="step-order">{`Step ${a.order}`}</span> <code>{a.actionType}</code> <TierBadge tier={a.tier} />
                </p>
                <p className="muted">{`target: ${a.target}${a.proposedBy === "mcp_client" ? " · proposed by MCP client" : ""}`}</p>
                <Authority a={a} approval={approval} />
                <p className="step-status">{statusText(a, approval)}</p>
                {a.dryRun ? <p className="dry-run">{`dry run ${a.dryRun.ok ? "ok" : "failed"}: ${a.dryRun.ok ? a.dryRun.changes.join("; ") : (a.dryRun.failureReason ?? "")}`}</p> : null}
                {BLOCKED.includes(a.status) ? (
                  <p className="step-blocked"><span>{`reason: ${a.classificationReasons.join("; ")}`}</span></p>
                ) : null}
              </li>
            );
          })}
        </ol>
        {held ? (
          <div className="gate-decision">
            <p>{`Decision for ${pending.map((a) => a.id).join(", ")}. Applies to all pending approvals in the batch.`}</p>
            <div className="gate-buttons">
              <button ref={approveRef} type="button" className="btn button-approve" onClick={() => setDialog("approve")}>Approve</button>
              <button ref={rejectRef} type="button" className="btn button-danger" onClick={() => setDialog("reject")}>Reject</button>
            </div>
          </div>
        ) : null}
        {pending.length === 0 && approvals.length > 0 ? (
          <p className="gate-decided">{`Approvals: ${approvals.map((a) => `${a.id} ${APPROVAL_STATUS_LABELS[a.status]}`).join(", ")}`}</p>
        ) : null}
      </div>
      <ApprovalDialog
        open={dialog !== null}
        decision={dialog ?? "approve"}
        approvalIds={pending.map((a) => a.id)}
        onConfirm={() => {
          const chosen = dialog;
          setDialog(null);
          if (chosen) onDecide?.(chosen);
        }}
        onClose={() => setDialog(null)}
        returnFocusTo={dialog === "reject" ? rejectRef : approveRef}
      />
    </section>
  );
}
