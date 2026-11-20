// War Room App (spec 10.2; AC-39): scenario, replay up to the gate, decision, chosen branch, numbers and post-mortem.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App.tsx";
import { rec } from "./fixtures/recording.ts";

const fakeFetchFor = (files: Record<string, unknown>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const name = String(input).replace(/^\.\/demo\//, "").replace(/\.json$/, "");
    return name in files ? new Response(JSON.stringify(files[name]), { status: 200 }) : new Response("nothing", { status: 404 });
  }) as typeof fetch;

async function playToGate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
  while (!screen.queryByRole("button", { name: "Approve" })) await user.click(screen.getByRole("button", { name: "Step" }));
}

describe("App", () => {
  it("plays a scenario, approves at the gate and shows the postmortem", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    expect(screen.getByRole("status").textContent).toContain("Replay of a recorded run");
    await playToGate(user);
    expect(screen.queryByRole("heading", { name: /Incident numbers/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    while (screen.queryByRole("button", { name: "Step" })?.hasAttribute("disabled") === false) await user.click(screen.getByRole("button", { name: "Step" }));
    expect(await screen.findByRole("heading", { name: /Post-mortem/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Incident numbers/ })).toBeTruthy();
    expect(screen.getByText(/narrative validated by the numeric guard/)).toBeTruthy();
    expect(screen.getByText("resolved")).toBeTruthy(); // status in the incident header
    expect(screen.getByRole("status").textContent).toContain("Replay of a recorded run");
  });

  it("rejecting follows the rejected branch to an escalated incident", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await playToGate(user);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    while (screen.queryByRole("button", { name: "Step" })?.hasAttribute("disabled") === false) await user.click(screen.getByRole("button", { name: "Step" }));
    expect(await screen.findByText(/deterministic template narrative/)).toBeTruthy();
    expect(screen.getByText("escalated")).toBeTruthy(); // status in the incident header
    expect(screen.queryByRole("heading", { name: /Incident numbers/ })).toBeNull();
  });

  it("keeps keyboard focus where the action is: step button, gate and postmortem", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Step" }));
    for (let i = 0; i < rec.common.events.length; i++) await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Approval gate" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Approve" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Step" }));
    for (let i = 0; i < rec.branches!.approved.events.length; i++) await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(await screen.findByRole("heading", { name: /Post-mortem/ }));
  });

  it("shows an explicit error for an invalid recording", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: { ...rec, label: "other" } })} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid recording/);
    expect(screen.queryByRole("heading", { name: /Incident numbers/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Agent conversation/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Step" })).toBeNull();
  });

  it("shows an explicit error when the index cannot be loaded", async () => {
    render(<App fetchImpl={fakeFetchFor({})} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load \.\/demo\/index\.json/);
    expect(screen.getByRole("status").textContent).toContain("Replay of a recorded run");
  });

  it("moves focus to Pause when playing and back to Step when paused", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Step" }));
  });

  it("returns focus to the picker heading after Change scenario", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    await user.click(screen.getByRole("button", { name: "Change scenario" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a scenario" }));
  });

  it("stamps the gate strip HOLD while held and APPROVED after the decision", async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={fakeFetchFor({ index: [rec.scenario], [rec.scenario.id]: rec })} />);
    await playToGate(user);
    expect(screen.getByText("HOLD")).toBeTruthy();
    expect(document.querySelector(".strip.is-held")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.queryByText("HOLD")).toBeNull();
    expect(screen.getByText("APPROVED")).toBeTruthy();
  });

  it("retries loading the index after a failure", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const flaky = (async (input: RequestInfo | URL) => {
      calls++;
      if (calls === 1) return new Response("nothing", { status: 503 });
      return fakeFetchFor({ index: [rec.scenario] })(input);
    }) as typeof fetch;
    render(<App fetchImpl={flaky} />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables the picker while a recording loads, so a second click cannot race the first", async () => {
    const user = userEvent.setup();
    const other = { ...rec.scenario, id: "cost-anomaly", title: "Other scenario" };
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("index.json")) return new Response(JSON.stringify([rec.scenario, other]), { status: 200 });
      if (url.includes(rec.scenario.id)) {
        await slowGate;
        return new Response(JSON.stringify(rec), { status: 200 });
      }
      return new Response("nothing", { status: 404 });
    }) as typeof fetch;
    render(<App fetchImpl={fetchImpl} />);
    await user.click(await screen.findByRole("button", { name: new RegExp(rec.scenario.title) }));
    expect(screen.getByRole("button", { name: /Other scenario/ }).hasAttribute("disabled")).toBe(true);
    releaseSlow();
    expect(await screen.findByRole("heading", { name: /Agent conversation/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
