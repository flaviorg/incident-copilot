// Diálogo de confirmação da decisão (spec 10.2, item 4; AC-39): role dialog modal com nome e descrição, foco preso,
// Escape fecha e devolve o foco, e o aviso de que nada real acontece.
import { useId, useRef } from "react";
import type { RefObject } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.ts";

export function ApprovalDialog({ open, decision, approvalIds = [], onConfirm, onClose, returnFocusTo }: {
  open: boolean;
  decision: "approve" | "reject";
  approvalIds?: string[];
  onConfirm: () => void;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(ref, { active: open, onEscape: onClose, returnFocusTo });
  if (!open) return null;
  const verb = decision === "approve" ? "Approve" : "Reject";
  const ids = approvalIds.length > 0 ? ` ${approvalIds.join(", ")}` : "";
  return (
    <div className="dialog-backdrop">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1}>
        <h2 id={titleId}>{`${verb}${ids}?`}</h2>
        <p id={descId}>
          {decision === "approve"
            ? "The replay continues along the recorded branch in which all pending approvals were approved."
            : "The replay continues along the recorded branch in which all pending approvals were rejected; dependent steps are cancelled."}
        </p>
        <p className="dialog-warning">
          <strong>Local simulation: no real action.</strong> The decision only picks which recording to continue.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className={decision === "approve" ? "button-primary" : "button-danger"} onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
