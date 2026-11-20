// Recording replay engine (spec 10.2; AC-39), pure and clockless: advances one event per step, stops at the end
// of the common prefix when there are branches and none is chosen, and follows the chosen branch to the end. The War Room does not
// compute anything: the state shown is always one of the snapshots recorded by the backend.
import type { DemoRecording, RecordingBranch, TraceEvent } from "@contracts";

export type Branch = "approved" | "rejected";

export type ReplayState = {
  recording: DemoRecording;
  /** How many events are already visible. */
  cursor: number;
  branch: Branch | null;
  pausedAtGate: boolean;
  finished: boolean;
};

function sequence(s: Pick<ReplayState, "recording" | "branch">): TraceEvent[] {
  const { common, branches } = s.recording;
  return s.branch && branches ? [...common.events, ...branches[s.branch].events] : common.events;
}

function settle(s: ReplayState): ReplayState {
  const total = sequence(s).length;
  if (s.cursor < total) return s;
  if (s.branch === null && s.recording.branches !== null) return { ...s, pausedAtGate: true };
  return { ...s, finished: true };
}

export function createReplay(r: DemoRecording): ReplayState {
  return settle({ recording: r, cursor: 0, branch: null, pausedAtGate: false, finished: false });
}

/** Advances one event. Stopped at the gate or at the end, returns the same state. */
export function step(s: ReplayState): ReplayState {
  if (s.pausedAtGate || s.finished) return s;
  return settle({ ...s, cursor: s.cursor + 1 });
}

/** Chooses the recorded branch; only valid while stopped at the gate. */
export function choose(s: ReplayState, b: Branch): ReplayState {
  if (!s.pausedAtGate || s.branch !== null || s.recording.branches === null) return s;
  return settle({ ...s, branch: b, pausedAtGate: false });
}

export function visibleEvents(s: ReplayState): TraceEvent[] {
  return sequence(s).slice(0, s.cursor);
}

/**
 * Snapshot of the current point. Up to the gate (and while the branch plays), incident, metrics and post-mortem are those
 * of the common prefix; the branch's approvals apply from the choice onward, because the decision has already been made. At the end of the branch, everything
 * comes from the branch, with the accumulated audit.
 */
export function currentSnapshot(s: ReplayState): RecordingBranch {
  const { common, branches } = s.recording;
  const chosen = s.branch && branches ? branches[s.branch] : null;
  const events = visibleEvents(s);
  if (chosen && s.finished) return { ...chosen, events, audit: [...common.audit, ...chosen.audit] };
  if (chosen) return { ...common, events, approvals: chosen.approvals };
  return { ...common, events };
}
