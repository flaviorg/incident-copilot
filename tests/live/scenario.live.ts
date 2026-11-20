// Optional live test (spec 8.1 and 8.2): runs the deploy scenario against OpenRouter and asserts structure only.
// It is outside the npm test glob and is skipped without OPENROUTER_API_KEY. Run with `npm run test:live` and a .env with
// OPENROUTER_API_KEY and OPENROUTER_MODEL. It does not measure model quality: it only checks that the contracts hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../src/config.ts";
import { createContainer } from "../../src/app/container.ts";
import { effectiveStatus } from "../../src/domain/approval/approval-machine.ts";
import { isExecutable } from "../../src/domain/autonomy/catalog.ts";
import { LlmUnavailableError, RunTimeoutError } from "../../src/domain/errors.ts";
import { RootCauseCategorySchema } from "../../src/contracts/index.ts";
import type { IncidentView } from "../../src/contracts/index.ts";

const SCENARIO = "deploy-5xx-rollback";

test("deploy scenario against OpenRouter keeps the contracts", { skip: !process.env.OPENROUTER_API_KEY, timeout: 15 * 60_000 }, async () => {
  const token = randomBytes(24).toString("base64url");
  const config = loadConfig(
    { ...process.env, LLM_PROVIDER: "openrouter", CLOCK: "simulated", DB_PATH: ":memory:", APPROVAL_TOKEN: token, LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" },
  );
  const c = createContainer(config);
  try {
    let view: IncidentView;
    try {
      view = await c.incidents.open({ scenarioId: SCENARIO }, { requestId: "live-test" });
    } catch (e) {
      // LLM unavailable or timeout: the incident was already saved as escalated, with a partial report from the template.
      if (!(e instanceof LlmUnavailableError || e instanceof RunTimeoutError)) throw e;
      view = c.incidents.get(c.incidents.list({ limit: 1 })[0]!.id);
    }
    const id = view.incident.id;

    // The test human approves everything the gate asks for; the resume runs through the same path as the API.
    for (;;) {
      const pending = c.store.listApprovals({ incidentId: id }).find((a) => effectiveStatus(a, c.clock.now()) === "pending");
      if (!pending) break;
      await c.approvals.decide(pending.id, { decision: "approve", approver: "teste ao vivo" }, token, { requestId: "live-test" });
    }
    view = c.incidents.get(id);

    assert.ok(["resolved", "escalated"].includes(view.incident.status), `status final inesperado: ${view.incident.status}`);
    if (view.diagnosis) assert.ok(RootCauseCategorySchema.safeParse(view.diagnosis.category).success, `categoria fora do enum: ${view.diagnosis.category}`);
    for (const step of view.plan?.steps ?? []) {
      const action = view.actions.find((a) => a.order === step.order && a.actionType === step.actionType);
      const blocked = action !== undefined && ["blocked_forbidden", "blocked_unknown"].includes(action.status);
      assert.ok(isExecutable(step.actionType) || blocked, `step ${step.order} (${step.actionType}) is outside the catalog and was not blocked`);
    }
    for (const a of view.actions) assert.ok(a.tier >= 1 && a.tier <= 4);

    const pm = c.incidents.postmortem(id);
    assert.ok(pm.numericGuard.passed || pm.numericGuard.usedTemplate, "the narrative failed the numeric guard and the template was not used");
  } finally {
    c.close();
  }
});
