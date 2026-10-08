// Replay das gravações (spec 8.2; AC-39): ordem dos eventos, pausa no portão, escolha do ramo e fim.
import { describe, expect, it } from "vitest";
import { choose, createReplay, currentSnapshot, step, visibleEvents } from "../replay/replay-engine.ts";
import type { ReplayState } from "../replay/replay-engine.ts";
import { rec } from "./fixtures/recording.ts";

const atGate = (): ReplayState => {
  let s = createReplay(rec);
  for (let i = 0; i < rec.common.events.length; i++) s = step(s);
  return s;
};

describe("replay engine", () => {
  it("starts empty, without autoplay", () => {
    const s = createReplay(rec);
    expect([s.cursor, s.branch, s.pausedAtGate, s.finished]).toEqual([0, null, false, false]);
    expect(visibleEvents(s)).toEqual([]);
  });

  it("plays common events in order and pauses at the gate", () => {
    let s = createReplay(rec);
    for (let i = 0; i < 3; i++) s = step(s);
    expect(visibleEvents(s).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.pausedAtGate).toBe(true);
    expect(step(s)).toEqual(s);
    expect(currentSnapshot(s).incident.incident.status).toBe("awaiting_approval");
    expect(currentSnapshot(s).postmortem).toBeNull();
  });

  it("choosing a branch continues with that branch", () => {
    let s = choose(atGate(), "rejected");
    expect([s.branch, s.pausedAtGate]).toEqual(["rejected", false]);
    expect(currentSnapshot(s).approvals[0]!.status).toBe("rejected");
    s = step(s);
    expect(visibleEvents(s).at(-1)!.id).toBe(rec.branches!.rejected.events[0]!.id);
  });

  it("finishes after the branch and exposes the final snapshot", () => {
    let s = choose(atGate(), "approved");
    expect(currentSnapshot(s).metrics).toBeNull();
    while (!s.finished) s = step(s);
    expect(visibleEvents(s).length).toBe(rec.common.events.length + rec.branches!.approved.events.length);
    const snap = currentSnapshot(s);
    expect(snap.incident.incident.status).toBe("resolved");
    expect(snap.metrics).toEqual(rec.branches!.approved.metrics);
    expect(snap.postmortem!.status).toBe("final");
    expect(snap.audit.length).toBe(rec.common.audit.length + rec.branches!.approved.audit.length);
    expect(step(s)).toEqual(s);
  });

  it("choose is ignored before the gate and after a branch was chosen", () => {
    const s = createReplay(rec);
    expect(choose(s, "approved")).toEqual(s);
    const chosen = choose(atGate(), "approved");
    expect(choose(chosen, "rejected")).toEqual(chosen);
  });

  it("a recording without approval plays to the end and never pauses", () => {
    let s = createReplay({ ...rec, branches: null });
    for (let i = 0; i < 3; i++) s = step(s);
    expect([s.pausedAtGate, s.finished]).toEqual([false, true]);
  });
});
