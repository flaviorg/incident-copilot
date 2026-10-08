// `diagnose --scenario <id>`: só o analista de telemetria (fake por padrão), com relógio simulado e banco em memória.
// Imprime o trace do ReAct (pensamento, ação, observação) e o diagnóstico.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { createContainer } from "../app/container.ts";
import { openIncidentRecord } from "../app/incident-setup.ts";
import { createTelemetryNode } from "../graph/nodes/telemetry-node.ts";
import { CATEGORY_LABELS, CONFIDENCE_LABELS, ESCALATION_LABELS } from "../domain/report/postmortem-template.ts";
import { renderEvent } from "./render.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

export async function runDiagnoseCommand(argv: string[], io: CliIO): Promise<number> {
  let scenarioId: string | undefined;
  try {
    const parsed = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { scenario: { type: "string" } } });
    scenarioId = parsed.values.scenario;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (!scenarioId) throw new UsageError("faltou --scenario <id>");

  const config = loadConfig({ ...io.env, DB_PATH: ":memory:", CLOCK: "simulated" });
  const c = createContainer(config);
  try {
    const { incident, blackboard } = openIncidentRecord(
      { store: c.store, scenarios: c.scenarios, clock: c.clock, ids: c.ids, initialWorld: (s) => c.infra.initialWorld(s) },
      { scenarioId },
      { requestId: null },
    );
    const bb = { ...blackboard, runId: c.ids.run() };
    io.out(`incident-copilot · diagnose · provedor: ${config.llmProvider === "fake" ? "fake roteirizado (sem rede, sem chave)" : `openrouter (${config.openrouterModel})`}`);
    io.out(`cenário ${scenarioId} · ${incident.service ?? `conta ${bb.alert.account ?? "?"}`} · ${incident.severity} · ${incident.id}`);
    io.out("");
    const node = createTelemetryNode({ llm: c.llm, tools: c.tools, scenarios: c.scenarios, trace: c.trace, clock: c.clock, limits: c.limits });
    const out = await node(bb, { signal: AbortSignal.timeout(config.runTimeoutMs), configurable: { requestId: null } });
    for (const e of c.store.listTrace(incident.id)) {
      const line = renderEvent(e);
      if (line) io.out(line);
    }
    io.out("");
    if (out.escalation) {
      io.err(`o analista não concluiu: ${ESCALATION_LABELS[out.escalation.reason]} (${out.escalation.detail})`);
      return 1;
    }
    const d = out.diagnosis!;
    io.out(`diagnóstico: ${d.category} (${CATEGORY_LABELS[d.category]}) · confiança ${CONFIDENCE_LABELS[d.confidence]}${d.capReached ? " · teto de passos atingido" : ""}`);
    io.out(`hipótese: ${d.hypothesis}`);
    for (const ev of d.evidence) io.out(`  evidência ${ev.source} ${ev.ref}: ${ev.summary}`);
    return 0;
  } finally {
    c.close();
  }
}
