// Agregações do /stats (spec 5.3; AC-33), todas em SQL sobre a janela pedida. Nada é agregado em memória: o código
// só monta o objeto com zeros para as chaves ausentes. MTTR P50 e P95 por posto mais próximo (nearest-rank), só sobre
// incidentes resolvidos; aprovação pendente vencida conta como expired por CASE, sem gravar nada.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { ActionStatusSchema, ApprovalStatusSchema, IncidentStatusSchema, StatsSchema } from "../contracts/index.ts";
import type { Stats, StatsWindow } from "../contracts/index.ts";
import type { Clock } from "../infra/clock.ts";

const STATS_WINDOW_SEC: Record<StatsWindow, number> = { "1h": 3600, "24h": 86_400, "7d": 604_800 };

/**
 * Offset do percentil por posto mais próximo: ceil(p × n) − 1, mínimo 0. O épsilon evita que um produto como
 * 0,95 × 60 = 57,00000000000001 suba um posto por erro de ponto flutuante.
 */
export function nearestRankOffset(n: number, p: number): number {
  return Math.max(0, Math.ceil(p * n - 1e-9) - 1);
}

type CountRow = { key: string | number; n: number };

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export class StatsService {
  private readonly clock: Clock;
  private readonly q: Record<string, StatementSync>;

  constructor(d: { db: DatabaseSync; clock: Clock }) {
    this.clock = d.clock;
    const p = (sql: string) => d.db.prepare(sql);
    this.q = {
      incidentsTotal: p("SELECT COUNT(*) AS n FROM incidents WHERE opened_at >= $since"),
      incidentsByStatus: p("SELECT status AS key, COUNT(*) AS n FROM incidents WHERE opened_at >= $since GROUP BY status"),
      resolvedCount: p("SELECT COUNT(*) AS n FROM incidents WHERE status = 'resolved' AND mttr_min IS NOT NULL AND opened_at >= $since"),
      mttrAt: p("SELECT mttr_min AS v FROM incidents WHERE status = 'resolved' AND mttr_min IS NOT NULL AND opened_at >= $since ORDER BY mttr_min LIMIT 1 OFFSET $offset"),
      actionsByTier: p("SELECT tier AS key, COUNT(*) AS n FROM actions WHERE created_at >= $since GROUP BY tier"),
      actionsByStatus: p("SELECT status AS key, COUNT(*) AS n FROM actions WHERE created_at >= $since GROUP BY status"),
      // Mesma regra do effectiveStatus: vencida quando agora passou de expires_at.
      approvalsByStatus: p(
        `SELECT CASE WHEN status = 'pending' AND expires_at < $now THEN 'expired' ELSE status END AS key, COUNT(*) AS n
         FROM approvals WHERE requested_at >= $since GROUP BY key`,
      ),
      guard: p(
        `SELECT
           COALESCE(SUM(CASE WHEN json_extract(json, '$.payload.by') = 'supervisor_guard' AND json_extract(json, '$.payload.verdict') = 'coerced' THEN 1 ELSE 0 END), 0) AS coercions,
           COALESCE(SUM(CASE WHEN json_extract(json, '$.payload.by') = 'auditor' AND json_extract(json, '$.payload.overridden') = 1 THEN 1 ELSE 0 END), 0) AS overrides,
           COALESCE(SUM(CASE WHEN json_extract(json, '$.payload.by') = 'numeric_guard' THEN 1 ELSE 0 END), 0) AS numeric
         FROM trace_events WHERE type = 'critique' AND ts >= $since`,
      ),
      llm: p(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
           COALESCE(SUM(prompt_tokens), 0) AS promptTokens, COALESCE(SUM(completion_tokens), 0) AS completionTokens,
           COALESCE(SUM(cost_usd), 0) AS cost
         FROM llm_calls WHERE ts >= $since`,
      ),
    };
  }

  private stmt(name: string): StatementSync {
    const s = this.q[name];
    if (!s) throw new Error(`consulta inexistente: ${name}`);
    return s;
  }

  private counts(name: string, params: Record<string, string>): Map<string, number> {
    const rows = this.stmt(name).all(params) as CountRow[];
    return new Map(rows.map((r) => [String(r.key), Number(r.n)]));
  }

  private percentile(since: string, n: number, p: number): number | null {
    if (n === 0) return null;
    const row = this.stmt("mttrAt").get({ since, offset: nearestRankOffset(n, p) }) as { v: number } | undefined;
    return row ? Number(row.v) : null;
  }

  get(window: StatsWindow): Stats {
    const now = this.clock.now();
    const since = new Date(now.getTime() - STATS_WINDOW_SEC[window] * 1000).toISOString();
    const at = { since };

    const incidents = zeros(IncidentStatusSchema.options);
    for (const [k, n] of this.counts("incidentsByStatus", at)) if (k in incidents) incidents[k as keyof typeof incidents] = n;

    const resolved = Number((this.stmt("resolvedCount").get(at) as { n: number }).n);

    const byTier = { "1": 0, "2": 0, "3": 0, "4": 0 };
    for (const [k, n] of this.counts("actionsByTier", at)) if (k in byTier) byTier[k as keyof typeof byTier] = n;
    const byStatus = zeros(ActionStatusSchema.options);
    for (const [k, n] of this.counts("actionsByStatus", at)) if (k in byStatus) byStatus[k as keyof typeof byStatus] = n;

    const approvals = zeros(ApprovalStatusSchema.options);
    for (const [k, n] of this.counts("approvalsByStatus", { since, now: now.toISOString() })) if (k in approvals) approvals[k as keyof typeof approvals] = n;

    const g = this.stmt("guard").get(at) as { coercions: number; overrides: number; numeric: number };
    const l = this.stmt("llm").get(at) as { calls: number; errors: number; promptTokens: number; completionTokens: number; cost: number };

    return StatsSchema.parse({
      window,
      incidents: { total: Number((this.stmt("incidentsTotal").get(at) as { n: number }).n), byStatus: incidents },
      mttrMin: { p50: this.percentile(since, resolved, 0.5), p95: this.percentile(since, resolved, 0.95) },
      actions: { byTier, byStatus },
      approvals,
      guard: { supervisorCoercions: Number(g.coercions), auditorOverrides: Number(g.overrides), numericGuardRejections: Number(g.numeric) },
      llm: {
        calls: Number(l.calls), errors: Number(l.errors), promptTokens: Number(l.promptTokens), completionTokens: Number(l.completionTokens),
        estimatedCostUsd: Math.round(Number(l.cost) * 1e6) / 1e6,
      },
    });
  }
}
