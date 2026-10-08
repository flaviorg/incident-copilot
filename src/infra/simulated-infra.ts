// Mundo simulado (spec 4.2, 6.4 e 7.3): dry run, execução, reversão e sinais pós-ação sobre um WorldState imutável.
// Cada ação executável tem uma entrada em EXECUTORS, tipado por ExecutableActionType: os tipos proibidos não têm
// executor por construção (faixa 4, camada 1). Falhas de execução vêm de `faults` do cenário.
import type { DryRunResult, GatedAction, Inventory, MetricName, WorldState } from "../contracts/index.ts";
import { EXECUTABLE_ACTIONS, isExecutable } from "../domain/autonomy/catalog.ts";
import type { ExecutableActionType } from "../domain/autonomy/catalog.ts";
import { auditInventory, projectedMonthlyCostUsd, roundUsd } from "../domain/finops/inventory-audit.ts";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import type { SignalWindow } from "../domain/canary/canary-analyzer.ts";
import { clampFor, materializeSeries } from "../domain/telemetry/series.ts";
import type { LoadedScenario } from "./scenarios/scenario-loader.ts";
import { initialWorldFrom } from "./world.ts";

export { projectedMonthlyCostUsd };

export type ValidatedStep = { actionType: ExecutableActionType; target: string; params: Record<string, unknown> };
export type ExecutionResult = { ok: boolean; summary: string };

type Check = { ok: true; changes: string[] } | { ok: false; reason: string };
type Executor = {
  /** Valida contra o mundo e descreve a mudança. */
  check(w: WorldState, step: ValidatedStep, prices: CloudPrices): Check;
  /** Aplica sobre uma cópia (pode mutar `w`), só depois de um check aprovado. */
  apply(w: WorldState, step: ValidatedStep): void;
  /** Desfaz sobre uma cópia; devolve o motivo quando não dá para desfazer. Ausente nas ações irreversíveis. */
  revert?(w: WorldState, a: GatedAction): string | null;
};

const notFound = (target: string): Check => ({ ok: false, reason: `alvo não encontrado: ${target}` });
const str = (v: unknown) => (typeof v === "string" ? v : String(v));
const fmtGb = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** deployment/<serviço> */
function deploymentOf(w: WorldState, target: string) {
  const [kind, svc, ...rest] = target.split("/");
  if (kind !== "deployment" || !svc || rest.length > 0) return null;
  const dep = w.deployments[svc];
  return dep ? { svc, dep } : null;
}

/** image/<serviço>:<tag> */
function imageOf(w: WorldState, target: string) {
  const [kind, ref, ...rest] = target.split("/");
  if (kind !== "image" || !ref || rest.length > 0) return null;
  const [svc, tag, ...more] = ref.split(":");
  if (!svc || !tag || more.length > 0) return null;
  const dep = w.deployments[svc];
  return dep ? { svc, tag, dep } : null;
}

type ResourceKind = "volume" | "ip" | "instance";
/** <volume|ip|instance>/<conta>/<id> no inventário do mundo. */
function resourceOf(inv: Inventory | null, target: string, kinds: readonly ResourceKind[]) {
  const [kind, account, id, ...rest] = target.split("/");
  if (!inv || !kind || !account || !id || rest.length > 0 || account !== inv.account || !(kinds as readonly string[]).includes(kind)) return null;
  if (kind === "volume") {
    const v = inv.volumes.find((x) => x.id === id);
    return v ? { kind: "volume" as const, id, volume: v } : null;
  }
  if (kind === "ip") {
    const ip = inv.publicIps.find((x) => x.id === id);
    return ip ? { kind: "ip" as const, id, ip } : null;
  }
  const inst = inv.instances.find((x) => x.id === id);
  return inst ? { kind: "instance" as const, id, instance: inst } : null;
}

const remove = <T>(list: T[], value: T) => list.filter((x) => x !== value);

const EXECUTORS: Record<ExecutableActionType, Executor> = {
  add_incident_note: {
    check: (_w, s) => {
      const [kind, ref, ...rest] = s.target.split("/");
      if (kind !== "incident" || !ref || rest.length > 0) return notFound(s.target);
      return { ok: true, changes: [`${s.target}: nota registrada`] };
    },
    apply: (w, s) => void w.notes.push(str(s.params.text)),
  },
  block_image_tag: {
    check: (w, s) => {
      const img = imageOf(w, s.target);
      if (!img) return notFound(s.target);
      if (!img.dep.history.some((v) => v === img.tag || v === `v${img.tag}`)) {
        return { ok: false, reason: `imagem ${img.svc}:${img.tag} não existe no histórico de deploys de ${img.svc}` };
      }
      if (img.dep.blockedTags.includes(img.tag)) return { ok: false, reason: `tag ${img.svc}:${img.tag} já está bloqueada` };
      return { ok: true, changes: [`${s.target}: tag bloqueada para promoção`] };
    },
    apply: (w, s) => {
      const img = imageOf(w, s.target)!;
      img.dep.blockedTags.push(img.tag);
    },
    revert: (w, a) => {
      const img = imageOf(w, a.target);
      if (!img) return `alvo não encontrado: ${a.target}`;
      img.dep.blockedTags = remove(img.dep.blockedTags, img.tag);
      return null;
    },
  },
  tag_resource_for_review: {
    check: (w, s) => {
      if (!resourceOf(w.inventory, s.target, ["volume", "ip", "instance"])) return notFound(s.target);
      if (w.tagsForReview.includes(s.target)) return { ok: false, reason: `${s.target} já está marcado para revisão` };
      return { ok: true, changes: [`${s.target}: marcado para revisão (${str(s.params.reason)})`] };
    },
    apply: (w, s) => void w.tagsForReview.push(s.target),
    revert: (w, a) => {
      w.tagsForReview = remove(w.tagsForReview, a.target);
      return null;
    },
  },
  create_volume_snapshot: {
    check: (w, s) => {
      const r = resourceOf(w.inventory, s.target, ["volume"]);
      if (!r || r.kind !== "volume") return notFound(s.target);
      return { ok: true, changes: [`${s.target}: snapshot de ${fmtGb(r.volume.sizeGb)} GB criado`] };
    },
    apply: (w, s) => {
      if (!w.snapshots.includes(s.target)) w.snapshots.push(s.target);
    },
    revert: (w, a) => {
      w.snapshots = remove(w.snapshots, a.target);
      return null;
    },
  },
  rollback_deployment: {
    check: (w, s) => {
      const d = deploymentOf(w, s.target);
      if (!d) return notFound(s.target);
      const to = str(s.params.toVersion);
      if (to === d.dep.version) return { ok: false, reason: `${s.target} já roda ${to}` };
      if (!d.dep.history.includes(to)) return { ok: false, reason: `versão ${to} não existe no histórico de deploys de ${d.svc}` };
      return { ok: true, changes: [`${s.target}: ${d.dep.version} -> ${to} (${d.dep.replicas} réplicas)`] };
    },
    apply: (w, s) => {
      const { dep } = deploymentOf(w, s.target)!;
      dep.previousVersion = dep.version;
      dep.version = str(s.params.toVersion);
    },
    revert: (w, a) => {
      const d = deploymentOf(w, a.target);
      if (!d) return `alvo não encontrado: ${a.target}`;
      const restore = d.dep.previousVersion;
      d.dep.version = restore;
      d.dep.previousVersion = d.dep.history[d.dep.history.indexOf(restore) - 1] ?? str(a.params.toVersion);
      return null;
    },
  },
  release_elastic_ip: {
    check: (w, s) => {
      const r = resourceOf(w.inventory, s.target, ["ip"]);
      if (!r || r.kind !== "ip") return notFound(s.target);
      if (r.ip.associatedWith !== null) return { ok: false, reason: `IP ${r.id} associado a ${r.ip.associatedWith}` };
      return { ok: true, changes: [`${s.target}: IPv4 público liberado`] };
    },
    apply: (w, s) => {
      const r = resourceOf(w.inventory, s.target, ["ip"])!;
      w.inventory!.publicIps = w.inventory!.publicIps.filter((x) => x.id !== r.id);
    },
  },
  delete_volume: {
    check: (w, s) => {
      const r = resourceOf(w.inventory, s.target, ["volume"]);
      if (!r || r.kind !== "volume") return notFound(s.target);
      if (r.volume.attachedTo !== null) return { ok: false, reason: `volume ${r.id} anexado a ${r.volume.attachedTo}` };
      return { ok: true, changes: [`${s.target}: volume ${r.volume.type} de ${fmtGb(r.volume.sizeGb)} GB excluído`] };
    },
    apply: (w, s) => {
      const r = resourceOf(w.inventory, s.target, ["volume"])!;
      w.inventory!.volumes = w.inventory!.volumes.filter((x) => x.id !== r.id);
    },
  },
  resize_instance: {
    check: (w, s, prices) => {
      const r = resourceOf(w.inventory, s.target, ["instance"]);
      if (!r || r.kind !== "instance") return notFound(s.target);
      const to = str(s.params.toType);
      if (to === r.instance.type) return { ok: false, reason: `${s.target} já é ${to}` };
      if (prices.instanceHourUsd[to] === undefined) return { ok: false, reason: `tipo ${to} sem preço na tabela de preços` };
      return { ok: true, changes: [`${s.target}: ${r.instance.type} -> ${to}`] };
    },
    apply: (w, s) => {
      const r = resourceOf(w.inventory, s.target, ["instance"])!;
      if (r.kind === "instance") r.instance.type = str(s.params.toType);
    },
    revert: (w, a) => {
      const r = resourceOf(w.inventory, a.target, ["instance"]);
      const original = resourceOf(w.initialInventory, a.target, ["instance"]);
      if (!r || r.kind !== "instance" || !original || original.kind !== "instance") return `alvo não encontrado: ${a.target}`;
      r.instance.type = original.instance.type;
      return null;
    },
  },
};

export class SimulatedInfra {
  private readonly prices: CloudPrices;

  constructor(o: { prices: CloudPrices }) {
    this.prices = o.prices;
  }

  initialWorld(s: LoadedScenario): WorldState {
    return initialWorldFrom(s);
  }

  /** Não muda `w`. */
  dryRun(w: WorldState, step: ValidatedStep): DryRunResult {
    const spec = EXECUTABLE_ACTIONS[step.actionType];
    const c = EXECUTORS[step.actionType].check(w, step, this.prices);
    return {
      ok: c.ok,
      changes: c.ok ? c.changes.slice(0, 10) : [],
      reversible: spec.reversible,
      estimatedDurationSec: spec.durationSec,
      failureReason: c.ok ? null : c.reason,
    };
  }

  /** Efeito puro, usado no dry run sequencial do portão e na execução. Lança se o dry run reprovaria (defeito de quem chama). */
  apply(w: WorldState, step: ValidatedStep): WorldState {
    const c = EXECUTORS[step.actionType].check(w, step, this.prices);
    if (!c.ok) throw new Error(`apply de ${step.actionType} em ${step.target} com dry run reprovado: ${c.reason}`);
    const next = structuredClone(w);
    EXECUTORS[step.actionType].apply(next, step);
    return next;
  }

  /** Falha injetada pelo cenário (`faults["<tipo>@<alvo>"] === "fail"`) ou mundo que mudou desde o portão: mundo intacto. */
  execute(w: WorldState, step: ValidatedStep, s: LoadedScenario): { world: WorldState; result: ExecutionResult } {
    if (s.file.faults[`${step.actionType}@${step.target}`] === "fail") {
      return { world: w, result: { ok: false, summary: `falha injetada pelo cenário em ${step.actionType} ${step.target}` } };
    }
    const c = EXECUTORS[step.actionType].check(w, step, this.prices);
    if (!c.ok) return { world: w, result: { ok: false, summary: c.reason } };
    const next = structuredClone(w);
    EXECUTORS[step.actionType].apply(next, step);
    return { world: next, result: { ok: true, summary: c.changes.join("; ") } };
  }

  /** Só ações reversíveis do catálogo. */
  revert(w: WorldState, a: GatedAction): { world: WorldState; result: ExecutionResult } {
    const executor = isExecutable(a.actionType) ? EXECUTORS[a.actionType] : undefined;
    if (!executor?.revert || !isExecutable(a.actionType) || !EXECUTABLE_ACTIONS[a.actionType].reversible) {
      return { world: w, result: { ok: false, summary: `${a.actionType} não é reversível` } };
    }
    const next = structuredClone(w);
    const problem = executor.revert(next, a);
    if (problem !== null) return { world: w, result: { ok: false, summary: problem } };
    return { world: next, result: { ok: true, summary: `${a.target}: ${a.actionType} revertida` } };
  }

  /**
   * Janela pós-ação: no deploy, a 1ª variante de after.json cujo `when` casa com os fatos do mundo; com inventário,
   * projected_monthly_cost_usd calculado dele. Sem nada disso, janela vazia (o canário reprova: fail closed).
   */
  postActionSignals(w: WorldState, s: LoadedScenario): SignalWindow {
    const metrics: Partial<Record<MetricName, number[]>> = {};
    if (s.after) {
      const facts = this.facts(w);
      const variant = s.after.variants.find((v) => Object.entries(v.when).every(([k, val]) => facts[k] === val));
      if (variant) {
        for (const [metric, spec] of Object.entries(variant.series) as [MetricName, NonNullable<(typeof variant.series)[MetricName]>][]) {
          metrics[metric] = materializeSeries(spec, new Date(0), s.after.resolutionSec, s.after.windowSec, { clamp: clampFor(metric) }).map((p) => p.value);
        }
      }
    }
    if (w.inventory) metrics.projected_monthly_cost_usd = [projectedMonthlyCostUsd(w.inventory, this.prices)];
    return { metrics };
  }

  /** Economia mensal do achado de inventário do alvo (sobre o inventário inicial); 0 para ações não FinOps. */
  monthlySavingsFor(a: GatedAction, w: WorldState): number {
    const base = w.initialInventory;
    if (!base) return 0;
    if (a.actionType === "resize_instance") {
      const inst = resourceOf(base, a.target, ["instance"]);
      if (!inst || inst.kind !== "instance") return 0;
      const from = this.prices.instanceHourUsd[inst.instance.type];
      const to = this.prices.instanceHourUsd[str(a.params.toType)];
      if (from === undefined || to === undefined || to >= from) return 0;
      return roundUsd((from - to) * this.prices.hoursPerMonth);
    }
    const finding = auditInventory(base, this.prices).findings.find((f) => f.target === a.target && f.recommendation.actionType === a.actionType);
    return finding?.monthlySavingsUsd ?? 0;
  }

  /** Fatos do mundo usados para escolher a variante de after.json ("deployment.<svc>.version" etc.). */
  facts(w: WorldState): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [svc, d] of Object.entries(w.deployments)) {
      out[`deployment.${svc}.version`] = d.version;
      out[`deployment.${svc}.previousVersion`] = d.previousVersion;
      out[`deployment.${svc}.replicas`] = String(d.replicas);
    }
    return out;
  }
}
