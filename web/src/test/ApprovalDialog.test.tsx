// Diálogo de aprovação (spec 10.2; AC-39): foco entra, fica preso, ESC fecha e devolve o foco a quem abriu.
import { describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalDialog } from "../components/ApprovalDialog.tsx";

function Harness({ onConfirm = () => {} }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button">antes</button>
      <button type="button" ref={opener} onClick={() => setOpen(true)}>Aprovar</button>
      <button type="button">depois</button>
      <ApprovalDialog
        open={open}
        decision="approve"
        approvalIds={["APR-0001"]}
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        returnFocusTo={opener}
      />
    </>
  );
}

describe("ApprovalDialog", () => {
  it("moves focus in, traps it, closes on Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Aprovar" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("names itself, warns that nothing real runs and confirms the decision", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Aprovar" }));
    const dialog = screen.getByRole("dialog", { name: /Aprovar/ });
    expect(dialog.textContent).toContain("Simulação local: nenhuma ação real");
    expect(dialog.textContent).toContain("APR-0001");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Aprovar" }));
  });

  it("Cancelar closes without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Aprovar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
