// Regras do auditor (spec 4.7): o código é o piso do veredito. O LLM pode endurecer, nunca afrouxar. Puro.
// O alvo de cada passo é resolvido pelo último segmento do caminho (instance/data-platform/i-0db51 -> i-0db51).
import type { AuditCheck, Deploy, Inventory, PlanStep, RemediationPlan } from "../../contracts/index.ts";
import { IDLE_CPU_MAX_PCT } from "../finops/inventory-audit.ts";

export type AuditEvidence = { inventory: Inventory | null; deploys: Deploy[]; impactStartedAt: string };

export const AUDITOR_RULE_IDS = [
  "snapshot_before_delete",
  "resize_requires_low_cpu",
  "release_requires_unassociated",
  "rollback_requires_recent_deploy",
  "depends_on_valid",
] as const;
export type AuditorRuleId = (typeof AUDITOR_RULE_IDS)[number];

/** Janela do deploy suspeito antes do início do impacto. */
const RECENT_DEPLOY_WINDOW_MIN = 60;
const NOT_APPLICABLE = "not applicable";

const targetId = (target: string): string => target.split("/").filter(Boolean).at(-1) ?? target;

const clip = (s: string) => (s.length <= 300 ? s : s.slice(0, 299) + "…");

/** Ordem de tamanho dentro da família: nano < micro < small < medium < large < xlarge < 2xlarge < ... */
function sizeRank(type: string): number | null {
  const size = type.split(".")[1];
  if (!size) return null;
  const base = ["nano", "micro", "small", "medium", "large", "xlarge"].indexOf(size);
  if (base >= 0) return base;
  const m = /^(\d+)xlarge$/.exec(size);
  return m ? 5 + Number(m[1]) - 1 : null;
}

type StepResult = { ok: boolean; detail: string };

function combine(rule: AuditorRuleId, steps: PlanStep[], check: (s: PlanStep) => StepResult | null): AuditCheck {
  const results = steps.map((s) => ({ s, r: check(s) })).filter((x): x is { s: PlanStep; r: StepResult } => x.r !== null);
  if (results.length === 0) return { rule, passed: true, detail: NOT_APPLICABLE };
  const bad = results.filter((x) => !x.r.ok);
  if (bad.length === 0) return { rule, passed: true, detail: clip(results.map((x) => `step ${x.s.order}: ${x.r.detail}`).join("; ")) };
  return { rule, passed: false, detail: clip(bad.map((x) => `step ${x.s.order}: ${x.r.detail}`).join("; ")) };
}

export function runAuditorRules(plan: RemediationPlan, e: AuditEvidence): AuditCheck[] {
  const steps = [...plan.steps].sort((a, b) => a.order - b.order);
  const orders = new Set(steps.map((s) => s.order));

  const snapshot = combine("snapshot_before_delete", steps, (s) => {
    if (s.actionType !== "delete_volume") return null;
    const id = targetId(s.target);
    const snap = steps.find((o) => o.actionType === "create_volume_snapshot" && targetId(o.target) === id && o.order < s.order && s.dependsOn.includes(o.order));
    return snap
      ? { ok: true, detail: `snapshot of ${id} in step ${snap.order}` }
      : { ok: false, detail: `delete_volume of ${id} without a create_volume_snapshot of the same target in an earlier step listed in dependsOn` };
  });

  const resize = combine("resize_requires_low_cpu", steps, (s) => {
    if (s.actionType !== "resize_instance") return null;
    const id = targetId(s.target);
    const inst = e.inventory?.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, detail: `instance ${id} not found in the inventory` };
    const toType = typeof s.params.toType === "string" ? s.params.toType : null;
    const from = sizeRank(inst.type);
    const to = toType ? sizeRank(toType) : null;
    if (from !== null && to !== null && to >= from) return { ok: true, detail: `${inst.type} -> ${toType} does not reduce the size` };
    return inst.avgCpuPct14d <= IDLE_CPU_MAX_PCT
      ? { ok: true, detail: `14-day average CPU of ${id} = ${inst.avgCpuPct14d}%` }
      : { ok: false, detail: `14-day average CPU of ${id} = ${inst.avgCpuPct14d}%, above ${IDLE_CPU_MAX_PCT}%` };
  });

  const release = combine("release_requires_unassociated", steps, (s) => {
    if (s.actionType !== "release_elastic_ip") return null;
    const id = targetId(s.target);
    const ip = e.inventory?.publicIps.find((i) => i.id === id);
    if (!ip) return { ok: false, detail: `IP ${id} not found in the inventory` };
    return ip.associatedWith === null ? { ok: true, detail: `IP ${id} not associated` } : { ok: false, detail: `IP ${id} associated with ${ip.associatedWith}` };
  });

  const rollback = combine("rollback_requires_recent_deploy", steps, (s) => {
    if (s.actionType !== "rollback_deployment") return null;
    const service = targetId(s.target);
    const impact = Date.parse(e.impactStartedAt);
    const recent = e.deploys
      .filter((d) => d.service === service)
      .filter((d) => {
        const at = Date.parse(d.at);
        return at <= impact && at >= impact - RECENT_DEPLOY_WINDOW_MIN * 60_000;
      })
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!recent) return { ok: false, detail: `no deploy of ${service} within ${RECENT_DEPLOY_WINDOW_MIN} min before the start of impact` };
    const toVersion = s.params.toVersion;
    return toVersion === recent.previousVersion
      ? { ok: true, detail: `rollback from ${recent.version} to the previous version ${recent.previousVersion}` }
      : { ok: false, detail: `toVersion ${String(toVersion)} differs from the version before deploy ${recent.version} (${recent.previousVersion})` };
  });

  const deps = combine("depends_on_valid", steps, (s) => {
    if (s.dependsOn.length === 0) return null;
    const bad = s.dependsOn.filter((d) => !(d < s.order && orders.has(d)));
    return bad.length === 0
      ? { ok: true, detail: `depends on ${s.dependsOn.join(", ")}` }
      : { ok: false, detail: `dependsOn points to a missing or later step: ${bad.join(", ")}` };
  });

  return [snapshot, resize, release, rollback, deps];
}

/** Tabela do spec 4.7: regra falha mais approve do LLM vira revise sobrescrito; sem LLM, valem as regras. */
export function combineAuditorVerdict(checks: AuditCheck[], llm: "approve" | "revise" | null): { verdict: "approve" | "revise"; overridden: boolean } {
  const allPass = checks.every((c) => c.passed);
  if (llm === null) return { verdict: allPass ? "approve" : "revise", overridden: false };
  if (!allPass && llm === "approve") return { verdict: "revise", overridden: true };
  return { verdict: llm, overridden: false };
}
