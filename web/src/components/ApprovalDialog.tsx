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
  const verb = decision === "approve" ? "Aprovar" : "Rejeitar";
  const ids = approvalIds.length > 0 ? ` ${approvalIds.join(", ")}` : "";
  return (
    <div className="dialog-backdrop">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1}>
        <h2 id={titleId}>{`${verb}${ids}?`}</h2>
        <p id={descId}>
          {decision === "approve"
            ? "A reprodução segue pelo ramo gravado em que todas as aprovações pendentes foram aprovadas."
            : "A reprodução segue pelo ramo gravado em que todas as aprovações pendentes foram rejeitadas; os passos dependentes são cancelados."}
        </p>
        <p className="dialog-warning">
          <strong>Simulação local: nenhuma ação real.</strong> A decisão só escolhe qual gravação continuar.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="button" className={decision === "approve" ? "button-primary" : "button-danger"} onClick={onConfirm}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}
