// Gravações da War Room (spec 4.2, 5.2, 7.6 e 10.2; AC-39). Cada cenário roda duas vezes, em containers novos com
// banco :memory:, relógio simulado, provedor fake forçado e token aleatório: uma execução aprova todas as aprovações e
// a outra rejeita todas. O prefixo comum (até o portão) sai da 1ª execução e é conferido contra a 2ª; cada ramo leva
// o restante do trace e da auditoria e o estado final. Cenário sem aprovação: tudo no prefixo comum e branches null.
// Tudo passa por redactSecrets e pelo DemoRecordingSchema antes de sair.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { DEMO_LABEL, DemoRecordingSchema, ScenarioSummarySchema } from "../contracts/index.ts";
import type { DemoRecording, RecordingBranch, ScenarioSummary } from "../contracts/index.ts";
import { effectiveStatus } from "../domain/approval/approval-machine.ts";
import { loadFixtures } from "../llm/fixture-format.ts";
import { ALL_PROMPTS } from "../prompts/v1/index.ts";
import { projectPath } from "../infra/paths.ts";
import { redactSecrets } from "../infra/redact.ts";
import { ScenarioRepository } from "../infra/scenarios/scenario-loader.ts";
import { createContainer } from "./container.ts";
import type { Container } from "./container.ts";

const DEMO_RECORDER_APPROVER = "demo operator";

export type RecordOptions = { fixturesDir?: string };
type Branch = "approved" | "rejected";

function demoContainer(o: RecordOptions): { c: Container; token: string } {
  const token = randomBytes(24).toString("base64url");
  // Ambiente próprio, sem herdar process.env: nenhuma chave real entra na gravação, e o fake é forçado.
  const config = loadConfig({ DB_PATH: ":memory:", LLM_PROVIDER: "fake", CLOCK: "simulated", LOG_LEVEL: "warn", APPROVAL_TOKEN: token }, { forceFake: true });
  const c = createContainer(config, o.fixturesDir ? { fixtures: loadFixtures(o.fixturesDir) } : {});
  return { c, token };
}

/** Estado do incidente no ponto atual; `events` e `audit` são só o que veio depois de `fromSeq` e `fromAudit`. */
function snapshot(c: Container, incidentId: string, fromSeq: number, fromAudit: number): RecordingBranch {
  const incident = c.incidents.get(incidentId);
  const { blackboard } = c.store.loadBlackboard(incidentId);
  return {
    events: c.store.listTrace(incidentId).filter((e) => e.seq > fromSeq),
    incident,
    approvals: incident.approvals,
    audit: c.incidents.audit(incidentId).slice(fromAudit),
    metrics: blackboard.metrics,
    postmortem: blackboard.postmortem,
  };
}

async function runBranch(scenarioId: string, branch: Branch, o: RecordOptions): Promise<{ scenario: ScenarioSummary; common: RecordingBranch; rest: RecordingBranch | null; token: string }> {
  const { c, token } = demoContainer(o);
  try {
    const scenario = c.scenarios.get(scenarioId).summary;
    const opened = await c.incidents.open({ scenarioId }, { requestId: null });
    const id = opened.incident.id;
    const common = snapshot(c, id, 0, 0);
    const pending = () => c.store.listApprovals({ incidentId: id }).find((a) => effectiveStatus(a, c.clock.now()) === "pending");
    if (!pending()) return { scenario, common, rest: null, token };
    const latencySec = c.scenarios.get(scenarioId).file.demo.approvalLatencySec;
    for (let next = pending(); next; next = pending()) {
      c.clock.tick(latencySec);
      await c.approvals.decide(next.id, { decision: branch === "approved" ? "approve" : "reject", approver: DEMO_RECORDER_APPROVER }, token, { requestId: null });
    }
    return { scenario, common, rest: snapshot(c, id, common.events.at(-1)?.seq ?? 0, common.audit.length), token };
  } finally {
    c.close();
  }
}

export async function recordScenario(scenarioId: string, o: RecordOptions = {}): Promise<DemoRecording> {
  return (await recordScenarioWithTokens(scenarioId, o)).recording;
}

/** A gravação e os tokens efêmeros usados nas decisões de cada ramo, para a varredura de segredos (AC-17) conferir que não vazam. */
export async function recordScenarioWithTokens(scenarioId: string, o: RecordOptions = {}): Promise<{ recording: DemoRecording; approvalTokens: string[] }> {
  const approved = await runBranch(scenarioId, "approved", o);
  const secrets = [approved.token];
  let branches: DemoRecording["branches"] = null;
  if (approved.rest) {
    const rejected = await runBranch(scenarioId, "rejected", o);
    secrets.push(rejected.token);
    if (JSON.stringify(rejected.common) !== JSON.stringify(approved.common)) {
      throw new Error(`non-deterministic recording: the common prefix of ${scenarioId} differs between runs`);
    }
    if (!rejected.rest) throw new Error(`inconsistent recording: the rejected run of ${scenarioId} did not reach a decision`);
    branches = { approved: approved.rest, rejected: rejected.rest };
  }
  const recording: DemoRecording = {
    schemaVersion: 1,
    label: DEMO_LABEL,
    recordedWith: { provider: "fake", promptVersions: ALL_PROMPTS.map((p) => p.version) },
    scenario: approved.scenario,
    common: approved.common,
    branches,
  };
  return { recording: DemoRecordingSchema.parse(redactSecrets(recording, secrets)), approvalTokens: secrets };
}

/** Grava index.json (ScenarioSummary[]) e <id>.json de cada cenário em `outDir`; devolve arquivo e tamanho. */
export async function recordAll(outDir: string, o: RecordOptions = {}): Promise<{ file: string; bytes: number }[]> {
  const scenarios = ScenarioSummarySchema.array().parse(new ScenarioRepository({ rootDir: projectPath("fixtures", "scenarios") }).list());
  mkdirSync(outDir, { recursive: true });
  const written: { file: string; bytes: number }[] = [];
  const write = (name: string, value: unknown) => {
    const text = JSON.stringify(value) + "\n";
    const file = join(outDir, name);
    writeFileSync(file, text);
    written.push({ file, bytes: Buffer.byteLength(text) });
  };
  write("index.json", scenarios);
  for (const s of scenarios) write(`${s.id}.json`, await recordScenario(s.id, o));
  return written;
}
