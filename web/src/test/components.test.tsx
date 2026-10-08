// Componentes acessíveis (spec 10.2; AC-39): faixa por texto e ícone, rótulo da demo, ROI ilustrativo e axe sem violações.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { DEMO_LABEL } from "@contracts";
import { TierBadge } from "../components/TierBadge.tsx";
import { ModeBanner } from "../components/ModeBanner.tsx";
import { MetricsCards } from "../components/MetricsCards.tsx";
import { AgentConversation } from "../components/AgentConversation.tsx";
import { ApprovalGate } from "../components/ApprovalGate.tsx";
import { ApprovalDialog } from "../components/ApprovalDialog.tsx";
import { PostmortemView } from "../components/PostmortemView.tsx";
import { ScenarioPicker } from "../components/ScenarioPicker.tsx";
import { PlaybackControls } from "../components/PlaybackControls.tsx";
import { createReplay } from "../replay/replay-engine.ts";
import { AGENT_NAMES } from "../labels.ts";
import { rec } from "./fixtures/recording.ts";

const evts = [...rec.common.events, ...rec.branches!.approved.events];
const gateProps = { actions: rec.common.incident.actions, approvals: rec.common.approvals, onDecide: () => {} };
const dlgProps = { decision: "approve" as const, approvalIds: ["APR-0001"], onConfirm: () => {}, onClose: () => {}, returnFocusTo: { current: null } };
const doc = rec.branches!.approved.postmortem!;

describe("components", () => {
  it("TierBadge communicates the tier by text", () => {
    render(<TierBadge tier={3} />);
    expect(screen.getByText("Faixa 3")).toBeTruthy();
    expect(document.querySelector(".tier-badge svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".tier-badge")!.classList.contains("tier-3")).toBe(true);
  });

  it("ModeBanner shows the literal label", () => {
    render(<ModeBanner />);
    expect(screen.getByRole("status").textContent).toContain("Reprodução de execução gravada com provedor fake roteirizado");
    expect(screen.getByRole("status").textContent).toContain(DEMO_LABEL);
  });

  it("MetricsCards labels ROI as illustrative", () => {
    render(<MetricsCards metrics={rec.branches!.approved.metrics!} />);
    expect(screen.getByText(/ilustrativo/)).toBeTruthy();
    expect(screen.getByText(/MTTR/)).toBeTruthy();
    expect(screen.getByText(/aguardando aprovação/i)).toBeTruthy();
    expect(screen.queryByText(/economia mensal/i)).toBeNull();
    expect(screen.getAllByText("medido").length).toBeGreaterThan(0);
  });

  it("MetricsCards shows monthly savings only when positive", () => {
    render(<MetricsCards metrics={{ ...rec.branches!.approved.metrics!, monthlySavingsUsd: 339.59 }} />);
    expect(screen.getByText(/economia mensal/i)).toBeTruthy();
    expect(screen.getByText(/339,59/)).toBeTruthy();
  });

  it("AgentConversation groups by agent and writes handoffs with interface names", () => {
    render(<AgentConversation events={evts} />);
    expect(screen.getByText(/Supervisor para Analista de telemetria: Correlacione/)).toBeTruthy();
    expect(document.querySelectorAll("details").length).toBeGreaterThan(0);
    expect(AGENT_NAMES.telemetry_analyst).toBe("Analista de telemetria");
  });

  it("ApprovalGate shows tiers, dry run, block reason and one decision pair", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<ApprovalGate {...gateProps} onDecide={onDecide} />);
    expect(screen.getByText("Faixa 4")).toBeTruthy();
    expect(screen.getByText(/v3\.8\.0 -> v3\.7\.2/)).toBeTruthy();
    expect(screen.getByText(/proibida por construção/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Rejeitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(onDecide).toHaveBeenCalledWith("reject");
  });

  it("ScenarioPicker lists scenarios as buttons and PlaybackControls does not autoplay", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScenarioPicker scenarios={[rec.scenario]} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: new RegExp(rec.scenario.title) }));
    expect(onSelect).toHaveBeenCalledWith("deploy-5xx-rollback");
    const onPlay = vi.fn();
    render(<PlaybackControls state={createReplay(rec)} playing={false} onStep={() => {}} onPlay={onPlay} onPause={() => {}} />);
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pausar" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Avançar" }).hasAttribute("disabled")).toBe(false);
  });

  it("PostmortemView shows the numeric guard seal", () => {
    const { unmount } = render(<PostmortemView doc={doc} />);
    expect(screen.getByRole("heading", { name: /Post-mortem/ })).toBeTruthy();
    expect(screen.getByText(/narrativa validada pelo guarda numérico/)).toBeTruthy();
    unmount();
    render(<PostmortemView doc={rec.branches!.rejected.postmortem!} />);
    expect(screen.getByText(/narrativa do template/)).toBeTruthy();
  });

  it("axe finds no violations in conversation, gate, dialog and postmortem", async () => {
    for (const ui of [<AgentConversation events={evts} />, <ApprovalGate {...gateProps} />, <ApprovalDialog open {...dlgProps} />, <PostmortemView doc={doc} />]) {
      const { container, unmount } = render(ui);
      const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } }); // jsdom não calcula contraste; ver tokens-contrast
      expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      unmount();
    }
  });
});
