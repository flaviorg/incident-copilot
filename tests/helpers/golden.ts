// Metrics golden (spec 7.6) and execution of a whole scenario branch (opens, decides all pending, resumes).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectPath } from "../../src/infra/paths.ts";
import { effectiveStatus } from "../../src/domain/approval/approval-machine.ts";
import type { IncidentView } from "../../src/contracts/index.ts";
import { createTestContainer, TEST_APPROVAL_TOKEN } from "./container.ts";
import type { TestContainer, TestContainerOptions } from "./container.ts";

/** UPDATE_GOLDEN=1 grava tests/golden/<name>.json; otherwise compares with deepEqual. */
export function assertGolden(name: string, actual: unknown): void {
  const path = projectPath("tests", "golden", `${name}.json`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  if (!existsSync(path)) assert.fail(`golden ausente: tests/golden/${name}.json (rode npm run regen e revise o diff)`);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(readFileSync(path, "utf8")), `metrics differ from golden ${name} (if the change is intentional, run npm run regen and review the diff)`);
}

/**
 * Opens the scenario and decides all pending approvals (approve or reject) with the test token, advancing
 * demo.approvalLatencySec before each decision. The last decision triggers the resume.
 */
export async function runScenarioBranch(
  scenarioId: string,
  branch: "approved" | "rejected",
  o: TestContainerOptions = {},
): Promise<{ c: TestContainer; view: IncidentView }> {
  const c = createTestContainer(o);
  const opened = await c.incidents.open({ scenarioId }, { requestId: null });
  const latencySec = c.scenarios.get(scenarioId).file.demo.approvalLatencySec;
  for (;;) {
    const next = c.store.listApprovals({ incidentId: opened.incident.id }).find((a) => effectiveStatus(a, c.clock.now()) === "pending");
    if (!next) break;
    c.clock.tick(latencySec);
    await c.approvals.decide(next.id, { decision: branch === "approved" ? "approve" : "reject", approver: "test operator" }, TEST_APPROVAL_TOKEN, { requestId: null });
  }
  return { c, view: c.incidents.get(opened.incident.id) };
}
