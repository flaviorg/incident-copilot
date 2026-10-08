import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogPromptText, classifyAction, EXECUTABLE_ACTIONS, FORBIDDEN_ACTIONS, isExecutable, isMitigating, targetInScope,
} from "../../src/domain/autonomy/catalog.ts";
import type { ExecutableActionType } from "../../src/domain/autonomy/catalog.ts";

const ctx = { scope: { service: "orders-api", account: null, incidentId: "INC-0001" }, revisionsExhausted: false };
const costCtx = { scope: { service: null, account: "data-platform", incidentId: "INC-0002" }, revisionsExhausted: false };
const s = (actionType: string, target = "deployment/orders-api", params: Record<string, unknown> = {}, runbookRef: string | null = "orders-5xx-after-deploy#mitigacao") =>
  ({ actionType, target, params, runbookRef });

test("catalog tiers", () => {
  assert.equal(classifyAction(s("add_incident_note", "incident/INC-0001", { text: "x" }), ctx).tier, 2);
  assert.equal(classifyAction(s("block_image_tag", "image/orders-api:3.8.0"), ctx).tier, 2);
  assert.equal(classifyAction(s("rollback_deployment", "deployment/orders-api", { toVersion: "v3.7.2" }), ctx).tier, 3);
  assert.equal(classifyAction(s("tag_resource_for_review", "volume/data-platform/vol-0c41d2", { reason: "ocioso" }), costCtx).tier, 2);
  assert.equal(classifyAction(s("create_volume_snapshot", "volume/data-platform/vol-0c41d2"), costCtx).tier, 2);
  assert.equal(classifyAction(s("release_elastic_ip", "ip/data-platform/eipalloc-0f19"), costCtx).tier, 3);
  assert.equal(classifyAction(s("delete_volume", "volume/data-platform/vol-0c41d2"), costCtx).tier, 3);
  assert.equal(classifyAction(s("resize_instance", "instance/data-platform/i-07ab3", { toType: "r6i.large" }), costCtx).tier, 3);
  const ok = classifyAction(s("rollback_deployment", "deployment/orders-api", { toVersion: "v3.7.2" }), ctx);
  assert.deepEqual([ok.known, ok.executable, ok.paramsOk, ok.reasons], [true, true, true, ["faixa do catálogo: 3"]]);
  assert.deepEqual(ok.params, { toVersion: "v3.7.2" });
});

test("catalog values follow the spec 6.4 table", () => {
  const row = (t: ExecutableActionType) => [EXECUTABLE_ACTIONS[t].tier, EXECUTABLE_ACTIONS[t].mitigates, EXECUTABLE_ACTIONS[t].reversible, EXECUTABLE_ACTIONS[t].durationSec];
  assert.deepEqual(row("add_incident_note"), [2, false, false, 1]);
  assert.deepEqual(row("block_image_tag"), [2, false, true, 5]);
  assert.deepEqual(row("tag_resource_for_review"), [2, false, true, 2]);
  assert.deepEqual(row("create_volume_snapshot"), [2, false, true, 30]);
  assert.deepEqual(row("rollback_deployment"), [3, true, true, 90]);
  assert.deepEqual(row("release_elastic_ip"), [3, true, false, 5]);
  assert.deepEqual(row("delete_volume"), [3, true, false, 20]);
  assert.deepEqual(row("resize_instance"), [3, true, true, 300]);
  assert.equal(Object.keys(EXECUTABLE_ACTIONS).length, 8);
  assert.deepEqual([...FORBIDDEN_ACTIONS], ["delete_audit_log", "disable_security_scanner", "export_user_data", "run_arbitrary_command", "delete_backups"]);
  assert.equal(isMitigating("rollback_deployment"), true);
  assert.equal(isMitigating("block_image_tag"), false);
  assert.equal(isMitigating("delete_backups"), false);
  assert.equal(isExecutable("delete_volume"), true);
  assert.equal(isExecutable("delete_backups"), false);
  assert.equal(isExecutable("toString"), false);
});

test("forbidden and unknown are tier 4", () => {
  const f = classifyAction(s("delete_backups", "backup_vault/orders-api/prod"), ctx);
  assert.deepEqual([f.tier, f.known, f.executable, f.paramsOk, f.params], [4, true, false, false, null]);
  assert.ok(f.reasons.includes("proibida por construção (faixa 4)"));
  for (const t of FORBIDDEN_ACTIONS) assert.equal(classifyAction(s(t, "incident/INC-0001"), ctx).tier, 4, t);
  const u = classifyAction(s("capture_heap_dump"), ctx);
  assert.deepEqual([u.tier, u.known, u.executable], [4, false, false]);
  assert.deepEqual(u.reasons, ["tipo fora do catálogo: negar por padrão"]);
  assert.equal(classifyAction(s("__proto__"), ctx).tier, 4);
});

test("context rules only raise", () => {
  const out = classifyAction(s("block_image_tag", "image/payments-api:1.0"), ctx);
  assert.equal(out.tier, 3);
  assert.ok(out.reasons.includes("alvo fora do escopo do incidente"));
  const noRunbook = classifyAction(s("block_image_tag", "image/orders-api:3.8.0", {}, null), ctx);
  assert.equal(noRunbook.tier, 3);
  assert.ok(noRunbook.reasons.includes("passo sem runbook de referência"));
  const exhausted = classifyAction(s("block_image_tag", "image/orders-api:3.8.0"), { ...ctx, revisionsExhausted: true });
  assert.equal(exhausted.tier, 3);
  assert.ok(exhausted.reasons.includes("revisões do plano esgotadas"));
  // Tier 3 never goes down and tier 4 stays 4, whatever the context.
  assert.equal(classifyAction(s("rollback_deployment", "deployment/orders-api", { toVersion: "v3.7.2" }, null), { ...ctx, revisionsExhausted: true }).tier, 3);
  assert.equal(classifyAction(s("delete_backups", "backup_vault/orders-api/prod", {}, null), ctx).tier, 4);
  // Every reason is listed when several rules apply.
  const all = classifyAction(s("add_incident_note", "incident/INC-0009", { text: "x" }, null), { ...ctx, revisionsExhausted: true });
  assert.deepEqual(all.reasons, ["faixa do catálogo: 2", "alvo fora do escopo do incidente", "passo sem runbook de referência", "revisões do plano esgotadas"]);
});

test("invalid params are flagged", () => {
  assert.equal(classifyAction(s("rollback_deployment", "deployment/orders-api", {}), ctx).paramsOk, false);
  assert.equal(classifyAction(s("rollback_deployment", "deployment/orders-api", { toVersion: 3 }), ctx).paramsOk, false);
  assert.equal(classifyAction(s("add_incident_note", "incident/INC-0001", { text: "" }), ctx).paramsOk, false);
  assert.equal(classifyAction(s("block_image_tag", "image/orders-api:3.8.0", { force: true }), ctx).paramsOk, false);
  const bad = classifyAction(s("resize_instance", "instance/data-platform/i-07ab3", { toType: 1 }), costCtx);
  assert.deepEqual([bad.paramsOk, bad.params, bad.tier], [false, null, 3]);
});

test("target scope: the incident itself, the service or the account", () => {
  assert.equal(targetInScope("incident/INC-0001", ctx.scope), true);
  assert.equal(targetInScope("incident/orders-api", ctx.scope), true);
  assert.equal(targetInScope("incident/INC-0002", ctx.scope), false);
  assert.equal(targetInScope("deployment/orders-api", ctx.scope), true);
  assert.equal(targetInScope("image/orders-api:3.8.0", ctx.scope), true);
  assert.equal(targetInScope("deployment/payments-api", ctx.scope), false);
  assert.equal(targetInScope("deployment", ctx.scope), false);
  assert.equal(targetInScope("volume/data-platform/vol-0c41d2", costCtx.scope), true);
  assert.equal(targetInScope("volume/other-account/vol-1", costCtx.scope), false);
  assert.equal(targetInScope("deployment/orders-api", costCtx.scope), false);
});

test("forbidden types are not executable at the type level", () => {
  // @ts-expect-error delete_backups não pertence a ExecutableActionType
  const t: ExecutableActionType = "delete_backups";
  void t;
});

test("catalog prompt text lists every executable action and the forbidden ones", () => {
  const text = catalogPromptText();
  for (const t of Object.keys(EXECUTABLE_ACTIONS)) assert.match(text, new RegExp(`^- ${t}: `, "m"), t);
  assert.match(text, /rollback_deployment: deployment\/<serviço>; parâmetros \{ toVersion: string \}; mitiga o incidente/);
  for (const t of FORBIDDEN_ACTIONS) assert.ok(text.includes(t), t);
  assert.doesNotMatch(text, /faixa/i);
});
