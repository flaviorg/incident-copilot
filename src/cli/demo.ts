// `demo [--scenario <id>] [--reject] [--persist] [--json] [--live]` (spec 5.5 e 10.3; AC-38): roda o cenário inteiro com
// relógio simulado e banco em memória (ou DB_PATH com --persist). O operador demo decide cada aprovação pendente
// com um token efêmero gerado no processo e nunca impresso. Força o provedor fake; --live exige o OpenRouter configurado.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { createContainer } from "../app/container.ts";
import { projectPath } from "../infra/paths.ts";
import { redactSecrets } from "../infra/redact.ts";
import { effectiveStatus } from "../domain/approval/approval-machine.ts";
import { LlmUnavailableError, RunTimeoutError } from "../domain/errors.ts";
import { ESCALATION_LABELS } from "../domain/report/postmortem-template.ts";
import { TraceTypeSchema } from "../contracts/index.ts";
import type { IncidentView } from "../contracts/index.ts";
import { renderEvent, renderMetrics } from "./render.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

export type DemoOptions = { scenarioId: string; reject: boolean; persist: boolean; json: boolean; live: boolean };

const DEFAULT_DEMO_SCENARIO = "deploy-5xx-rollback";
const DEMO_APPROVER = "operador demo";

const time = (iso: string) => iso.slice(11, 19);

async function runDemo(o: DemoOptions, io: { out: (line: string) => void; env: Record<string, string | undefined> }): Promise<number> {
  const dbPath = o.persist ? (io.env.DB_PATH ?? projectPath("data", "incident-copilot.db")) : ":memory:";
  // Logs JSON (stderr) só a partir de warn, salvo LOG_LEVEL no ambiente: a saída da demo é o roteiro em pt-BR.
  const loaded = loadConfig({ ...io.env, CLOCK: "simulated", DB_PATH: dbPath, LOG_LEVEL: io.env.LOG_LEVEL ?? "warn" }, { forceFake: !o.live });
  // --live sem OpenRouter configurado falha em vez de cair no fake em silêncio (quem esqueceu o .env não acha que rodou o modelo).
  if (o.live && loaded.llmProvider !== "openrouter") {
    throw new UsageError("--live exige OPENROUTER_API_KEY e OPENROUTER_MODEL no ambiente ou no .env (e LLM_PROVIDER vazio ou openrouter)");
  }
  // Token efêmero quando o ambiente não define um; vai para a redação junto com os demais segredos.
  const config = { ...loaded, approvalToken: loaded.approvalToken ?? randomBytes(24).toString("base64url") };
  const token = config.approvalToken;
  const c = createContainer(config);
  try {
    const scenario = c.scenarios.get(o.scenarioId);
    const say = (line: string) => {
      if (!o.json) io.out(line);
    };
    const provider = config.llmProvider === "fake" ? "fake roteirizado (sem rede, sem chave)" : `openrouter (${config.openrouterModel})`;
    say(`incident-copilot · demo · provedor: ${provider}`);
    say(`cenário ${scenario.id} · ${scenario.file.service ? `serviço ${scenario.file.service}` : `conta ${scenario.file.account}`} · ${scenario.file.severity}`);
    say("");

    let view: IncidentView;
    try {
      view = await c.incidents.open({ scenarioId: scenario.id }, { requestId: null });
    } catch (e) {
      // O incidente já foi gravado escalado (llm_unavailable ou timeout); a demo mostra o desfecho.
      if (!(e instanceof LlmUnavailableError || e instanceof RunTimeoutError)) throw e;
      view = c.incidents.get(c.incidents.list({ limit: 1 })[0]!.id);
    }
    const id = view.incident.id;
    say(`${time(view.incident.openedAt)}  ${id} aberto: "${view.incident.title}" (impacto desde ${time(view.incident.impactStartedAt)})`);
    let lastSeq = 0;
    const flush = () => {
      for (const e of c.store.listTrace(id)) {
        if (e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        const line = renderEvent(e);
        if (line) say(line);
      }
    };
    flush();

    for (;;) {
      const next = c.store.listApprovals({ incidentId: id }).find((a) => effectiveStatus(a, c.clock.now()) === "pending");
      if (!next) break;
      c.clock.tick(scenario.file.demo.approvalLatencySec);
      const r = await c.approvals.decide(next.id, { decision: o.reject ? "reject" : "approve", approver: DEMO_APPROVER }, token, { requestId: null });
      say(`${time(r.approval.decidedAt ?? c.clock.now().toISOString())}  ${DEMO_APPROVER} ${o.reject ? "rejeitou" : "aprovou"} ${next.id} (token verificado, valor omitido)`);
      flush();
    }

    view = c.incidents.get(id);
    const esc = view.incident.escalation;
    say("");
    say(view.incident.status === "resolved"
      ? "desfecho: resolvido (canário saudável)"
      : esc ? `desfecho: escalado para humanos: ${esc.reason} (${ESCALATION_LABELS[esc.reason]})` : `desfecho: ${view.incident.status}`);
    say("");
    if (view.metrics) for (const line of renderMetrics(view.metrics)) say(line);
    const events = c.store.listTrace(id);
    const counts = TraceTypeSchema.options.map((t) => `${t} ${events.filter((e) => e.type === t).length}`).join(" · ");
    say("");
    say(`trace ${events.length} eventos (${counts})`);

    let postmortemPath: string | null = null;
    if (view.postmortemReady) {
      postmortemPath = `reports/${id}-postmortem.md`;
      mkdirSync(projectPath("reports"), { recursive: true });
      writeFileSync(projectPath(postmortemPath), redactSecrets(c.incidents.postmortemMarkdown(id), c.secrets));
      say(`post-mortem: ${postmortemPath}`);
    }
    if (o.json) io.out(JSON.stringify(redactSecrets({ incident: view, metrics: view.metrics, postmortemPath }, c.secrets), null, 2));
    return 0;
  } finally {
    c.close();
  }
}

export async function runDemoCommand(argv: string[], io: CliIO): Promise<number> {
  let values: { scenario?: string; reject?: boolean; persist?: boolean; json?: boolean; live?: boolean };
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        scenario: { type: "string" },
        reject: { type: "boolean" },
        persist: { type: "boolean" },
        json: { type: "boolean" },
        live: { type: "boolean" },
      },
    }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return runDemo(
    {
      scenarioId: values.scenario ?? DEFAULT_DEMO_SCENARIO,
      reject: values.reject ?? false,
      persist: values.persist ?? false,
      json: values.json ?? false,
      live: values.live ?? false,
    },
    io,
  );
}
