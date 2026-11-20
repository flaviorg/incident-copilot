// Recordings for the War Room (spec 4.2, 5.2, 7.6 and 10.2; AC-39). Each scenario runs twice, in fresh containers with
// an :memory: database, simulated clock, forced fake provider and a random token: one run approves all approvals and
// the other rejects all. The common prefix (up to the gate) comes from the 1st run and is checked against the 2nd; each branch carries
// the rest of the trace and audit, plus the final state. A scenario with no approval: everything in the common prefix and null branches.
// Everything goes through redactSecrets and DemoRecordingSchema before leaving.
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
  // Own environment, without inheriting process.env: no real key enters the recording, and the fake is forced.
  const config = loadConfig({ DB_PATH: ":memory:", LLM_PROVIDER: "fake", CLOCK: "simulated", LOG_LEVEL: "warn", APPROVAL_TOKEN: token }, { forceFake: true });
  const c = createContainer(config, o.fixturesDir ? { fixtures: loadFixtures(o.fixturesDir) } : {});
  return { c, token };
}

/** Incident state at the current point; `events` and `audit` are only what came after `fromSeq` and `fromAudit`. */
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

/** The recording and the ephemeral tokens used in each branch's decisions, so the secrets sweep (AC-17) can confirm they do not leak. */
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

/** Writes index.json (ScenarioSummary[]) and <id>.json for each scenario into `outDir`; returns file and size. */
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
