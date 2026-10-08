// Motor de reprodução das gravações (spec 10.2; AC-39), puro e sem relógio: avança um evento por passo, para no fim
// do prefixo comum quando há ramos e nenhum foi escolhido, e segue pelo ramo escolhido até o fim. A War Room não
// calcula nada: o estado mostrado é sempre um dos instantâneos gravados pelo backend.
import type { DemoRecording, RecordingBranch, TraceEvent } from "@contracts";

export type Branch = "approved" | "rejected";

export type ReplayState = {
  recording: DemoRecording;
  /** Quantos eventos já estão visíveis. */
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

/** Avança um evento. Parado no portão ou no fim, devolve o mesmo estado. */
export function step(s: ReplayState): ReplayState {
  if (s.pausedAtGate || s.finished) return s;
  return settle({ ...s, cursor: s.cursor + 1 });
}

/** Escolhe o ramo gravado; só vale parado no portão. */
export function choose(s: ReplayState, b: Branch): ReplayState {
  if (!s.pausedAtGate || s.branch !== null || s.recording.branches === null) return s;
  return settle({ ...s, branch: b, pausedAtGate: false });
}

export function visibleEvents(s: ReplayState): TraceEvent[] {
  return sequence(s).slice(0, s.cursor);
}

/**
 * Instantâneo do ponto atual. Até o portão (e enquanto o ramo é reproduzido), incidente, métricas e post-mortem são os
 * do prefixo comum; as aprovações do ramo valem desde a escolha, porque a decisão já foi tomada. No fim do ramo, tudo
 * vem do ramo, com a auditoria acumulada.
 */
export function currentSnapshot(s: ReplayState): RecordingBranch {
  const { common, branches } = s.recording;
  const chosen = s.branch && branches ? branches[s.branch] : null;
  const events = visibleEvents(s);
  if (chosen && s.finished) return { ...chosen, events, audit: [...common.audit, ...chosen.audit] };
  if (chosen) return { ...common, events, approvals: chosen.approvals };
  return { ...common, events };
}
