// Persistence with prepared statements, hand-written transactions and optimistic version (spec 4.2 and 4.3).
// Decides no business rules. JSON goes in TEXT columns; every read is validated with the matching Zod schema.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  ApprovalSchema, AuditEntrySchema, BlackboardSchema, GatedActionSchema, IncidentSchema, IncidentSummarySchema,
  LlmCallRecordSchema, RunRecordSchema, TraceEventSchema,
} from "../../contracts/index.ts";
import type {
  AgentId, Approval, ApprovalStatus, AuditEntry, AuditEvent, Blackboard, EscalationReason, GatedAction, Incident,
  IncidentStatus, IncidentSummary, LlmCallRecord, LlmCallRecordInput, NewIncident, RunRecord, Tier, TraceEvent, TraceType,
} from "../../contracts/index.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import { ConflictError, NotFoundError } from "../../domain/errors.ts";
import { sha256Hex } from "../crypto.ts";
import { redactSecrets } from "../redact.ts";
import { padId } from "../ids.ts";

export type SequenceName = "incident" | "approval" | "action" | "run" | "audit";

export type NewAuditEntry = { incidentId: string; actor: string; event: AuditEvent; tier: Tier | null; details: Record<string, unknown> };

export type IncidentStatusPatch = {
  resolvedAt?: string | null;
  escalation?: { reason: EscalationReason; detail: string } | null;
  mttrMin?: number | null;
};
export type IncidentFilter = { status?: IncidentStatus; service?: string; limit: number };
/** `types` filters by a set of types (in SQL, via json_each); combines with `type` by AND. */
export type TraceFilter = { type?: TraceType; types?: readonly TraceType[]; agent?: AgentId; limit?: number; last?: number };
export type ApprovalFilter = { status?: ApprovalStatus; incidentId?: string };

const GENESIS_HASH = "0".repeat(64);

type IncidentRow = {
  id: string; title: string; service: string | null; severity: string; status: string; scenario_id: string;
  opened_at: string; impact_started_at: string; detected_at: string; resolved_at: string | null;
  escalation_reason: string | null; escalation_detail: string | null; mttr_min: number | null;
};
type AuditRow = { id: string; ts: string; incident_id: string; actor: string; event: string; tier: number | null; details: string; prev_hash: string; hash: string };
type LlmCallRow = {
  incident_id: string; run_id: string; prompt_version: string; model: string; prompt_tokens: number; completion_tokens: number;
  cost_usd: number; latency_ms: number; success: number; error_kind: string | null; ts: string;
  attempts: number; used_fallback: number; usage_estimated: number;
};
type RunRow = { id: string; incident_id: string; started_at: string; ended_at: string | null; outcome: string | null };

const toIncident = (r: IncidentRow): Incident =>
  IncidentSchema.parse({
    id: r.id, title: r.title, service: r.service, severity: r.severity, status: r.status, scenarioId: r.scenario_id,
    openedAt: r.opened_at, impactStartedAt: r.impact_started_at, detectedAt: r.detected_at, resolvedAt: r.resolved_at,
    escalation: r.escalation_reason === null ? null : { reason: r.escalation_reason, detail: r.escalation_detail ?? "" },
  });

const toSummary = (r: IncidentRow): IncidentSummary =>
  IncidentSummarySchema.parse({
    id: r.id, title: r.title, service: r.service, severity: r.severity, status: r.status, scenarioId: r.scenario_id,
    openedAt: r.opened_at, resolvedAt: r.resolved_at, escalationReason: r.escalation_reason,
    mttrMin: r.mttr_min === null ? null : Number(r.mttr_min),
  });

export class SqliteIncidentStore {
  readonly db: DatabaseSync;
  private readonly secrets: readonly string[];
  private readonly now: () => Date;
  private txDepth = 0;
  private readonly stmt: Record<string, StatementSync>;

  constructor(db: DatabaseSync, opts: { secrets: readonly string[]; now: () => Date }) {
    this.db = db;
    this.secrets = opts.secrets;
    this.now = opts.now;
    const p = (sql: string) => db.prepare(sql);
    this.stmt = {
      nextSequence: p("INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value"),
      // auditoria
      // One chain per incident: the trail the API returns closes on its own, from the genesis hash.
      lastAuditHash: p("SELECT hash FROM audit_log WHERE incident_id = ? ORDER BY seq DESC LIMIT 1"),
      insertAudit: p("INSERT INTO audit_log (id, ts, incident_id, actor, event, tier, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      listAudit: p("SELECT * FROM audit_log WHERE incident_id = ? ORDER BY seq"),
      // incidentes
      insertIncident: p(
        `INSERT INTO incidents (id, title, service, severity, status, scenario_id, opened_at, impact_started_at, detected_at, resolved_at, escalation_reason, escalation_detail, mttr_min)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ),
      getIncident: p("SELECT * FROM incidents WHERE id = ?"),
      updateIncident: p(
        "UPDATE incidents SET status = ?, resolved_at = ?, escalation_reason = ?, escalation_detail = ?, mttr_min = ? WHERE id = ?",
      ),
      listIncidents: p(
        `SELECT * FROM incidents
         WHERE ($status IS NULL OR status = $status) AND ($service IS NULL OR service = $service)
         ORDER BY opened_at DESC, id DESC LIMIT $limit`,
      ),
      // blackboard
      loadBlackboard: p("SELECT json, version FROM blackboards WHERE incident_id = ?"),
      insertBlackboard: p("INSERT INTO blackboards (incident_id, json, version) VALUES (?, ?, 1) ON CONFLICT (incident_id) DO NOTHING"),
      updateBlackboard: p("UPDATE blackboards SET json = ?, version = version + 1 WHERE incident_id = ? AND version = ?"),
      // trace
      insertTrace: p("INSERT INTO trace_events (id, incident_id, run_id, request_id, seq, ts, agent, type, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      listTraceFirst: p(
        `SELECT json FROM trace_events
         WHERE incident_id = $incident AND ($type IS NULL OR type = $type) AND ($agent IS NULL OR agent = $agent)
           AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
         ORDER BY seq ASC LIMIT $limit`,
      ),
      listTraceLast: p(
        `SELECT json FROM (
           SELECT json, seq FROM trace_events
           WHERE incident_id = $incident AND ($type IS NULL OR type = $type) AND ($agent IS NULL OR agent = $agent)
             AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
           ORDER BY seq DESC LIMIT $limit
         ) ORDER BY seq ASC`,
      ),
      nextTraceSeq: p("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM trace_events WHERE incident_id = ?"),
      // actions
      upsertAction: p(
        `INSERT INTO actions (id, incident_id, ord, action_type, target, tier, status, executed_at, created_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET ord = excluded.ord, action_type = excluded.action_type, target = excluded.target,
           tier = excluded.tier, status = excluded.status, executed_at = excluded.executed_at, json = excluded.json`,
      ),
      listActions: p("SELECT json FROM actions WHERE incident_id = ? ORDER BY ord, rowid"),
      // approvals
      insertApproval: p(
        "INSERT INTO approvals (id, incident_id, action_id, status, requested_at, expires_at, decided_at, version, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      getApproval: p("SELECT json FROM approvals WHERE id = ?"),
      updateApproval: p("UPDATE approvals SET status = ?, decided_at = ?, version = ?, json = ? WHERE id = ? AND version = ?"),
      listApprovals: p(
        `SELECT json FROM approvals
         WHERE ($status IS NULL OR status = $status) AND ($incident IS NULL OR incident_id = $incident)
         ORDER BY requested_at, id`,
      ),
      // LLM calls and runs
      insertLlmCall: p(
        `INSERT INTO llm_calls (incident_id, run_id, prompt_version, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, success, error_kind, ts,
           attempts, used_fallback, usage_estimated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      listLlmCalls: p("SELECT * FROM llm_calls WHERE incident_id = ? ORDER BY id"),
      upsertRun: p(
        `INSERT INTO runs (id, incident_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET incident_id = excluded.incident_id, started_at = excluded.started_at,
           ended_at = excluded.ended_at, outcome = excluded.outcome`,
      ),
      listRuns: p("SELECT * FROM runs WHERE incident_id = ? ORDER BY started_at, id"),
    };
  }

  private s(name: string): StatementSync {
    const st = this.stmt[name];
    if (!st) throw new Error(`statement inexistente: ${name}`);
    return st;
  }

  // ---------- transaction and sequences ----------

  /** Hand-written BEGIN IMMEDIATE / COMMIT / ROLLBACK (DatabaseSync has no transaction()). A nested one reuses the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      if (result instanceof Promise) throw new TypeError("transaction() only accepts synchronous functions");
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  nextSequence(name: SequenceName): number {
    const row = this.s("nextSequence").get(name) as { value: number };
    return Number(row.value);
  }

  // ---------- auditoria ----------

  /**
   * Appends a chained row to the incident's trail: hash = sha256(prev_hash + "\n" + canonicalJson({ id, ts,
   * incidentId, actor, event, tier, details })), with prev_hash = hash of the last row of the same incident (or the genesis).
   */
  appendAudit(e: NewAuditEntry): AuditEntry {
    return this.transaction(() => {
      const id = padId("AUD", this.nextSequence("audit"));
      const ts = this.now().toISOString();
      const details = redactSecrets(e.details, this.secrets);
      const actor = redactSecrets(e.actor, this.secrets);
      const last = this.s("lastAuditHash").get(e.incidentId) as { hash: string } | undefined;
      const prevHash = last?.hash ?? GENESIS_HASH;
      const body = { id, ts, incidentId: e.incidentId, actor, event: e.event, tier: e.tier, details };
      const hash = sha256Hex(prevHash + "\n" + canonicalJson(body));
      this.s("insertAudit").run(id, ts, e.incidentId, actor, e.event, e.tier, JSON.stringify(details), prevHash, hash);
      return AuditEntrySchema.parse({ ...body, prevHash, hash });
    });
  }

  listAudit(incidentId: string): AuditEntry[] {
    return (this.s("listAudit").all(incidentId) as AuditRow[]).map((r) =>
      AuditEntrySchema.parse({
        id: r.id, ts: r.ts, incidentId: r.incident_id, actor: r.actor, event: r.event,
        tier: r.tier === null ? null : Number(r.tier), details: JSON.parse(r.details), prevHash: r.prev_hash, hash: r.hash,
      }),
    );
  }

  // ---------- incidentes ----------

  createIncident(i: NewIncident): Incident {
    const incident = IncidentSchema.parse({ ...i, status: "open", resolvedAt: null, escalation: null });
    this.s("insertIncident").run(
      incident.id, incident.title, incident.service, incident.severity, incident.scenarioId,
      incident.openedAt, incident.impactStartedAt, incident.detectedAt,
    );
    return incident;
  }

  getIncident(id: string): Incident | null {
    const row = this.s("getIncident").get(id) as IncidentRow | undefined;
    return row ? toIncident(row) : null;
  }

  /** Fields missing from the patch stay as they are; `null` clears. */
  updateIncidentStatus(id: string, status: IncidentStatus, patch: IncidentStatusPatch): void {
    this.transaction(() => {
      const row = this.s("getIncident").get(id) as IncidentRow | undefined;
      if (!row) throw new NotFoundError("not_found", `incident not found: ${id}`);
      const resolvedAt = patch.resolvedAt !== undefined ? patch.resolvedAt : row.resolved_at;
      let reason = row.escalation_reason;
      let detail = row.escalation_detail;
      if (patch.escalation !== undefined) {
        reason = patch.escalation?.reason ?? null;
        detail = patch.escalation?.detail ?? null;
      }
      const mttr = patch.mttrMin !== undefined ? patch.mttrMin : row.mttr_min;
      // validates before writing (status and reason come from enums)
      toIncident({ ...row, status, resolved_at: resolvedAt, escalation_reason: reason, escalation_detail: detail });
      this.s("updateIncident").run(status, resolvedAt, reason, detail, mttr, id);
    });
  }

  /** WHERE and LIMIT in SQL; ORDER BY opened_at DESC, id DESC. */
  listIncidents(f: IncidentFilter): IncidentSummary[] {
    const rows = this.s("listIncidents").all({ status: f.status ?? null, service: f.service ?? null, limit: f.limit }) as IncidentRow[];
    return rows.map(toSummary);
  }

  // ---------- blackboard ----------

  loadBlackboard(incidentId: string): { blackboard: Blackboard; version: number } {
    const row = this.s("loadBlackboard").get(incidentId) as { json: string; version: number } | undefined;
    if (!row) throw new NotFoundError("not_found", `blackboard not found: ${incidentId}`);
    return { blackboard: BlackboardSchema.parse(JSON.parse(row.json)), version: Number(row.version) };
  }

  /** Optimistic version: writes only if the current version is `expectedVersion` (0 = does not exist yet). Returns the new version. */
  saveBlackboard(incidentId: string, bb: Blackboard, expectedVersion: number): number {
    const json = JSON.stringify(BlackboardSchema.parse(bb));
    const result = expectedVersion === 0
      ? this.s("insertBlackboard").run(incidentId, json)
      : this.s("updateBlackboard").run(json, incidentId, expectedVersion);
    if (Number(result.changes) !== 1) {
      throw new ConflictError("version_conflict", `the blackboard of ${incidentId} changed since version ${expectedVersion}`);
    }
    return expectedVersion + 1;
  }

  // ---------- trace ----------

  appendTrace(events: TraceEvent[]): void {
    this.transaction(() => {
      for (const raw of events) {
        const e = TraceEventSchema.parse(raw);
        this.s("insertTrace").run(e.id, e.incidentId, e.runId, e.requestId, e.seq, e.ts, e.agent, e.type, JSON.stringify(e));
      }
    });
  }

  /** In seq order. `limit` = the first N; `last` = the N most recent, still in ascending order. With `type`, the event type is narrowed. */
  listTrace<T extends TraceType>(incidentId: string, f: TraceFilter & { type: T }): Extract<TraceEvent, { type: T }>[];
  listTrace(incidentId: string, f?: TraceFilter): TraceEvent[];
  listTrace(incidentId: string, f: TraceFilter = {}): TraceEvent[] {
    const params = { incident: incidentId, type: f.type ?? null, agent: f.agent ?? null, types: f.types === undefined ? null : JSON.stringify(f.types) };
    const rows = (f.last !== undefined
      ? this.s("listTraceLast").all({ ...params, limit: f.last })
      : this.s("listTraceFirst").all({ ...params, limit: f.limit ?? -1 })) as { json: string }[];
    return rows.map((r) => TraceEventSchema.parse(JSON.parse(r.json)));
  }

  nextTraceSeq(incidentId: string): number {
    return Number((this.s("nextTraceSeq").get(incidentId) as { next: number }).next);
  }

  // ---------- actions ----------

  upsertAction(a: GatedAction): void {
    const action = GatedActionSchema.parse(a);
    this.s("upsertAction").run(
      action.id, action.incidentId, action.order, action.actionType, action.target, action.tier, action.status,
      action.executedAt, this.now().toISOString(), JSON.stringify(action),
    );
  }

  listActions(incidentId: string): GatedAction[] {
    return (this.s("listActions").all(incidentId) as { json: string }[]).map((r) => GatedActionSchema.parse(JSON.parse(r.json)));
  }

  // ---------- approvals ----------

  createApproval(a: Approval): void {
    const ap = ApprovalSchema.parse(a);
    this.s("insertApproval").run(ap.id, ap.incidentId, ap.actionId, ap.status, ap.requestedAt, ap.expiresAt, ap.decidedAt, ap.version, JSON.stringify(ap));
  }

  getApproval(id: string): Approval | null {
    const row = this.s("getApproval").get(id) as { json: string } | undefined;
    return row ? ApprovalSchema.parse(JSON.parse(row.json)) : null;
  }

  /** Optimistic version: writes only if the current version is `expectedVersion`; the written version is always `expectedVersion + 1`. */
  transitionApproval(id: string, next: Approval, expectedVersion: number): void {
    if (next.id !== id) throw new TypeError(`transitionApproval: id divergente (${id} e ${next.id})`);
    const ap = ApprovalSchema.parse({ ...next, version: expectedVersion + 1 });
    const result = this.s("updateApproval").run(ap.status, ap.decidedAt, ap.version, JSON.stringify(ap), id, expectedVersion);
    if (Number(result.changes) !== 1) {
      throw new ConflictError("version_conflict", `approval ${id} changed since version ${expectedVersion}`);
    }
  }

  /** Stored status (the expiry projection belongs to the service). */
  listApprovals(f: ApprovalFilter): Approval[] {
    const rows = this.s("listApprovals").all({ status: f.status ?? null, incident: f.incidentId ?? null }) as { json: string }[];
    return rows.map((r) => ApprovalSchema.parse(JSON.parse(r.json)));
  }

  // ---------- LLM calls and runs ----------

  recordLlmCall(c: LlmCallRecordInput): void {
    const call = LlmCallRecordSchema.parse(c);
    this.s("insertLlmCall").run(
      call.incidentId, call.runId, call.promptVersion, call.model, call.promptTokens, call.completionTokens,
      call.costUsd, call.latencyMs, call.success ? 1 : 0, call.errorKind, call.ts,
      call.attempts, call.usedFallback ? 1 : 0, call.usageEstimated ? 1 : 0,
    );
  }

  listLlmCalls(incidentId: string): LlmCallRecord[] {
    return (this.s("listLlmCalls").all(incidentId) as LlmCallRow[]).map((r) =>
      LlmCallRecordSchema.parse({
        incidentId: r.incident_id, runId: r.run_id, promptVersion: r.prompt_version, model: r.model,
        promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens), costUsd: Number(r.cost_usd),
        latencyMs: Number(r.latency_ms), success: Number(r.success) === 1, errorKind: r.error_kind, ts: r.ts,
        attempts: Number(r.attempts), usedFallback: Number(r.used_fallback) === 1, usageEstimated: Number(r.usage_estimated) === 1,
      }),
    );
  }

  /** Upsert by id: writes the start and, later, the end and the outcome. */
  recordRun(r: RunRecord): void {
    const run = RunRecordSchema.parse(r);
    this.s("upsertRun").run(run.id, run.incidentId, run.startedAt, run.endedAt, run.outcome);
  }

  listRuns(incidentId: string): RunRecord[] {
    return (this.s("listRuns").all(incidentId) as RunRow[]).map((r) =>
      RunRecordSchema.parse({ id: r.id, incidentId: r.incident_id, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome }),
    );
  }
}
