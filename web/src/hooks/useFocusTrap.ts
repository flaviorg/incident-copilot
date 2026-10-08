// Foco preso no diálogo (spec 10.2; AC-39): ao ativar, o foco entra no primeiro controle; Tab e Shift+Tab circulam
// dentro do contêiner; foco que escapa volta; Escape chama onEscape; ao desativar, o foco volta para quem abriu.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  container: RefObject<HTMLElement | null>,
  o: { active: boolean; onEscape: () => void; returnFocusTo?: RefObject<HTMLElement | null> },
): void {
  const onEscape = useRef(o.onEscape);
  const returnFocusTo = useRef(o.returnFocusTo);
  useEffect(() => {
    onEscape.current = o.onEscape;
    returnFocusTo.current = o.returnFocusTo;
  });

  useEffect(() => {
    if (!o.active) return;
    const node = container.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));
    (items()[0] ?? node).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !node.contains(e.target)) (items()[0] ?? node).focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const target = returnFocusTo.current?.current ?? previous;
      if (target && target.isConnected) target.focus();
    };
  }, [o.active, container]);
}
