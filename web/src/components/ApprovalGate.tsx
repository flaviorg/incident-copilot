// Portão de aprovação (spec 10.2, item 4): passos com selo de faixa, resumo do dry run e motivo do bloqueio. Um par
// Aprovar e Rejeitar decide todas as aprovações pendentes do lote e escolhe o ramo gravado, depois de confirmar.
import { useRef, useState } from "react";
import type { Approval, GatedAction } from "@contracts";
import { ACTION_STATUS_LABELS, APPROVAL_STATUS_LABELS } from "../labels.ts";
import { ApprovalDialog } from "./ApprovalDialog.tsx";
import { TierBadge } from "./TierBadge.tsx";

const BLOCKED: readonly GatedAction["status"][] = ["blocked_forbidden", "blocked_unknown"];

function statusText(a: GatedAction, approval: Approval | undefined): string {
  if (a.status === "awaiting_approval" && approval) return `awaiting ${approval.id} (${APPROVAL_STATUS_LABELS[approval.status]})`;
  if (a.status === "ready") return "ready: runs after all decisions";
  if (BLOCKED.includes(a.status)) return "blocked without dry run";
  return ACTION_STATUS_LABELS[a.status];
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
  const steps = [...actions].sort((x, y) => x.order - y.order);
  return (
    <section className="panel" aria-labelledby="gate-title">
      <h2 id="gate-title" tabIndex={-1}>Approval gate</h2>
      <ol className="gate-steps">
        {steps.map((a) => {
          const approval = approvals.find((x) => x.id === a.approvalId);
          return (
            <li key={a.id} className="gate-step">
              <p className="gate-step-head">
                <span className="step-order">{`Step ${a.order}`}</span> <code>{a.actionType}</code> <TierBadge tier={a.tier} />
              </p>
              <p className="muted">{`target: ${a.target}${a.proposedBy === "mcp_client" ? " · proposed by MCP client" : ""}`}</p>
              <p>{statusText(a, approval)}</p>
              {a.dryRun ? <p className="dry-run">{`dry run ${a.dryRun.ok ? "ok" : "failed"}: ${a.dryRun.ok ? a.dryRun.changes.join("; ") : (a.dryRun.failureReason ?? "")}`}</p> : null}
              {BLOCKED.includes(a.status) ? <p className="step-blocked">{`reason: ${a.classificationReasons.join("; ")}`}</p> : null}
            </li>
          );
        })}
      </ol>
      {pending.length > 0 && onDecide ? (
        <div className="gate-decision">
          <p>{`Decision for ${pending.map((a) => a.id).join(", ")}. Applies to all pending approvals in the batch.`}</p>
          <div className="gate-buttons">
            <button ref={approveRef} type="button" className="button-primary" onClick={() => setDialog("approve")}>Approve</button>
            <button ref={rejectRef} type="button" className="button-danger" onClick={() => setDialog("reject")}>Reject</button>
          </div>
        </div>
      ) : null}
      {pending.length === 0 && approvals.length > 0 ? (
        <p className="gate-decided">{`Approvals: ${approvals.map((a) => `${a.id} ${APPROVAL_STATUS_LABELS[a.status]}`).join(", ")}`}</p>
      ) : null}
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
