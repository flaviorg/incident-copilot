// App da War Room (spec 10.2; AC-39): cenário, reprodução até o portão, decisão, ramo escolhido, números e post-mortem.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App.tsx";
import { rec } from "./fixtures/recording.ts";

const fakeFetchFor = (files: Record<string, unknown>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const name = String(input).replace(/^\.\/demo\//, "").replace(/\.json$/, "");
    return name in files ? new Response(JSON.stringify(files[name]), { status: 200 }) : new Response("nada", { status: 404 });
  }) as typeof fetch;

async function playToGate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
  while (!screen.queryByRole("button", { name: "Aprovar" })) await user.click(screen.getByRole("button", { name: "Avançar" }));
}

describe("App", () => {
  it("plays a scenario, approves at the gate and shows the postmortem", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    expect(screen.getByRole("status").textContent).toContain("Reprodução de execução gravada");
    await playToGate(user);
    expect(screen.queryByRole("heading", { name: /Números do incidente/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Aprovar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
    while (screen.queryByRole("button", { name: "Avançar" })?.hasAttribute("disabled") === false) await user.click(screen.getByRole("button", { name: "Avançar" }));
    expect(await screen.findByRole("heading", { name: /Post-mortem/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Números do incidente/ })).toBeTruthy();
    expect(screen.getByText(/narrativa validada pelo guarda numérico/)).toBeTruthy();
    expect(screen.getByText("resolvido")).toBeTruthy(); // status no cabeçalho do incidente
    expect(screen.getByRole("status").textContent).toContain("Reprodução de execução gravada");
  });

  it("rejecting follows the rejected branch to an escalated incident", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await playToGate(user);
    await user.click(screen.getByRole("button", { name: "Rejeitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    while (screen.queryByRole("button", { name: "Avançar" })?.hasAttribute("disabled") === false) await user.click(screen.getByRole("button", { name: "Avançar" }));
    expect(await screen.findByText(/narrativa do template/)).toBeTruthy();
    expect(screen.getByText("escalado")).toBeTruthy(); // status no cabeçalho do incidente
    expect(screen.queryByRole("heading", { name: /Números do incidente/ })).toBeNull();
  });

  it("keeps keyboard focus where the action is: step button, gate and postmortem", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Avançar" }));
    for (let i = 0; i < rec.common.events.length; i++) await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Portão de aprovação" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Aprovar" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Avançar" }));
    for (let i = 0; i < rec.branches!.approved.events.length; i++) await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(await screen.findByRole("heading", { name: /Post-mortem/ }));
  });

  it("shows an explicit error for an invalid recording", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: { ...rec, label: "outra" } })} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/gravação inválida/);
    expect(screen.queryByRole("heading", { name: /Números do incidente/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Conversa entre agentes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Avançar" })).toBeNull();
  });

  it("shows an explicit error when the index cannot be loaded", async () => {
    render(<App fetchImpl={fakeFetchFor({})} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/não foi possível carregar \.\/demo\/index\.json/);
    expect(screen.getByRole("status").textContent).toContain("Reprodução de execução gravada");
  });
});
