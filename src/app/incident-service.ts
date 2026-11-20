// Application service for incidents (spec 4.2, 4.5 and 5.1): opens, runs the graph as a stream, resumes and reads.
// Used by the three ports (CLI, HTTP, MCP). Persists before signaling an error: the caller always finds the incident
// saved, escalated and with a partial report, even when open throws LlmUnavailableError or RunTimeoutError.
import { GraphRecursionError } from "@langchain/langgraph";
import { ProposeRemediationInputSchema } from "../contracts/index.ts";
import type {
  Approval, AuditEntryView, AuditEvent, Blackboard, DryRunResult, Escalation, GatedAction, Incident, IncidentStatus, IncidentSummary, IncidentView, Limits,
  PostmortemDoc, ProposeRemediationInput, ProposeRemediationResult, TraceEvent, WorldState,
} from "../contracts/index.ts";
import type { IncidentFilter, SqliteIncidentStore, TraceFilter } from "../infra/db/incident-store.ts";
import type { LoadedScenario, ScenarioRepository } from "../infra/scenarios/scenario-loader.ts";
import type { Clock } from "../infra/clock.ts";
import type { Ids } from "../infra/ids.ts";
import type { Logger } from "../infra/logger.ts";
import { ConflictError, LlmUnavailableError, NotFoundError, RunTimeoutError, UnprocessableError, ValidationError } from "../domain/errors.ts";
import { classifyAction, runbookRefsOf, EXECUTABLE_ACTIONS, isExecutable } from "../domain/autonomy/catalog.ts";
import { parseWithIssues } from "../domain/validation.ts";
import { effectiveStatus, isExpired, transition } from "../domain/approval/approval-machine.ts";
import { ApprovalTransitionError } from "../domain/errors.ts";
import { ACTION_STATUS_LABELS } from "../domain/report/postmortem-template.ts";
import { deriveIncidentStatus } from "../domain/status/derive-status.ts";
import { renderPostmortemMarkdown } from "../domain/report/postmortem-template.ts";
import type { CompiledIncidentGraph } from "../graph/graph.ts";
import type { NodeConfig, NodeFn } from "../graph/run-context.ts";
import { actionArgs, DRY_RUN_SEC } from "../graph/nodes/gate-node.ts";
import type { ValidatedStep } from "../infra/simulated-infra.ts";
import type { TraceSink } from "./trace-sink.ts";
import { openIncidentRecord } from "./incident-setup.ts";
import { toAuditEntryView, toIncidentView } from "./views.ts";

export type IncidentServiceDeps = {
  store: SqliteIncidentStore;
  scenarios: ScenarioRepository;
  graph: CompiledIncidentGraph;
  clock: Clock;
  ids: Ids;
  limits: Limits;
  runTimeoutMs: number;
  logger: Logger;
  infra: { initialWorld(s: LoadedScenario): WorldState; dryRun(w: WorldState, step: ValidatedStep): DryRunResult };
  /** Nodes called outside the graph when the invocation overruns recursionLimit or time (spec 4.5). */
  direct: { escalation: NodeFn; reporter: NodeFn };
  /** Trace of external proposals (mcp_client agent). */
  trace: TraceSink;
  approvalTtlMin: number;
};

export type RunCtx = { requestId: string | null };

/** Action status that the rejection or expiry of a dependency cancels (spec 6.5, transitively). */
const CANCELLABLE: readonly GatedAction["status"][] = ["ready", "awaiting_approval", "approved"];

/**
 * Lease of a run (review 2026-11): a runs row with no end that this process is not running, and that started more than
 * runTimeoutMs plus this margin ago, belongs to a process that crashed or was killed. No live run can be that old
 * (the deadline aborts it), so it is closed as abandoned instead of blocking the incident forever.
 */
export const RUN_LEASE_MARGIN_MS = 60_000;

export class IncidentService {
  private readonly d: IncidentServiceDeps;
  /** Runs this process is executing right now; only rows outside this set can be abandoned. */
  private readonly activeRuns = new Set<string>();

  constructor(d: IncidentServiceDeps) {
    this.d = d;
  }

  /** Creates the incident (status open, phase new, incident_opened audit) and runs the first invocation. */
  async open(i: { scenarioId: string; title?: string }, ctx: RunCtx): Promise<IncidentView> {
    const { incident } = openIncidentRecord(
      { store: this.d.store, scenarios: this.d.scenarios, clock: this.d.clock, ids: this.d.ids, initialWorld: (s) => this.d.infra.initialWorld(s) },
      i,
      ctx,
    );
    this.d.logger.info("incident opened", { requestId: ctx.requestId, incidentId: incident.id, event: "incident_opened", scenarioId: i.scenarioId });
    const final = await this.run(incident.id, ctx);
    const view = this.get(incident.id);
    if (final.escalation?.reason === "llm_unavailable") throw new LlmUnavailableError(`model unavailable for incident ${incident.id}: ${final.escalation.detail}`);
    if (final.escalation?.reason === "timeout") throw new RunTimeoutError(`the run of incident ${incident.id} exceeded ${this.d.runTimeoutMs} ms`);
    return view;
  }

  /**
   * Resume after human decisions (ApprovalService writes phase "resume" first). Never throws for LLM or
   * timeout: returns the escalated view (review focus 4).
   */
  async resume(incidentId: string, ctx: RunCtx): Promise<IncidentView> {
    this.requireIncident(incidentId);
    const { blackboard } = this.d.store.loadBlackboard(incidentId);
    if (blackboard.phase !== "resume") {
      throw new ConflictError("incident_not_accepting", `incident ${incidentId} is not waiting to resume (phase ${blackboard.phase})`);
    }
    // Also the retry path after a failed resume (POST /incidents/:id/resume): never two runs on one incident.
    this.d.store.transaction(() => this.requireNoRunInProgress(incidentId));
    await this.run(incidentId, ctx);
    return this.get(incidentId);
  }

  /**
   * Materializes the expiry of all the incident's overdue approvals (spec 6.5): approval expired with
   * decisionSource expiry, action expired, dependents canceled and approval_expired audit. With no pending left,
   * writes phase "resume" in the same transaction; the caller triggers the resume. With a run in progress on the incident,
   * refuses with incident_not_accepting before writing anything (see requireNoRunInProgress).
   */
  expireDueApprovals(incidentId: string, now: Date, ctx: RunCtx = { requestId: null }): { expired: Approval[]; pendingLeft: number } {
    const { store } = this.d;
    return store.transaction(() => {
      this.requireIncident(incidentId);
      this.requireNoRunInProgress(incidentId);
      if (!store.listApprovals({ incidentId, status: "pending" }).some((a) => isExpired(a, now))) {
        return { expired: [], pendingLeft: this.pendingCount(incidentId, now) };
      }
      const { blackboard, version } = store.loadBlackboard(incidentId);
      const actions = blackboard.actions.map((a) => ({ ...a }));
      const expired = this.expireOverdue(incidentId, actions, now, ctx);
      const pendingLeft = this.pendingCount(incidentId, now);
      const phase = pendingLeft === 0 && blackboard.phase === "awaiting_approval" ? "resume" : blackboard.phase;
      this.persist(incidentId, { ...blackboard, actions, phase }, version, ctx);
      return { expired, pendingLeft };
    });
  }

  /**
   * Writes the human decision (approval with optimistic version, action approved or rejected, audit) and, on rejection,
   * cancels dependents transitively. With no pending left, writes phase "resume" in the same transaction. With a
   * run in progress on the incident, refuses with incident_not_accepting before writing anything.
   */
  applyDecision(approval: Approval, next: Approval, ctx: RunCtx = { requestId: null }): { pendingLeft: number } {
    const { store, clock } = this.d;
    const decided = next.status;
    if (decided !== "approved" && decided !== "rejected") throw new TypeError(`applyDecision expects approved or rejected, got ${decided}`);
    return store.transaction(() => {
      const incidentId = approval.incidentId;
      const incident = this.requireIncident(incidentId);
      this.requireNoRunInProgress(incidentId);
      if (incident.status === "escalated" || incident.status === "resolved") {
        throw new ConflictError("incident_not_accepting", `incident ${incidentId} is ${incident.status}; it no longer accepts decisions`);
      }
      store.transitionApproval(approval.id, next, approval.version);
      const { blackboard, version } = store.loadBlackboard(incidentId);
      const actions = blackboard.actions.map((a) => ({ ...a }));
      const action = actions.find((a) => a.id === approval.actionId);
      store.appendAudit({
        incidentId,
        actor: `human:${next.approver ?? "unknown"}`,
        event: next.status === "approved" ? "approval_approved" : "approval_rejected",
        tier: action?.tier ?? 3,
        details: {
          approvalId: next.id, actionId: next.actionId, actionType: action?.actionType ?? null, target: action?.target ?? null,
          source: next.decisionSource, comment: next.comment, requestId: ctx.requestId,
        },
      });
      const now = clock.now();
      if (action) {
        action.status = decided;
        store.upsertAction(action);
        if (decided === "rejected") {
          this.cancelDependents(actions, action, "rejected", now, ctx, { type: "reject", approver: next.approver ?? "unknown", source: next.decisionSource === "text" ? "text" : "structured" });
        }
      }
      // Overdue siblings must be recorded before counting: effectiveStatus already treats them as expired, so without
      // this the batch would resume while their rows, actions and dependents still said pending.
      this.expireOverdue(incidentId, actions, now, ctx);
      const pendingLeft = this.pendingCount(incidentId, now);
      const phase = pendingLeft === 0 && blackboard.phase === "awaiting_approval" ? "resume" : blackboard.phase;
      this.persist(incidentId, { ...blackboard, actions, phase }, version, ctx);
      return { pendingLeft };
    });
  }

  /**
   * The gate writes approvals in the middle of the run, but the blackboard is only written at the end of it (optimistic version).
   * A decision or expiry in that window would change the blackboard under the run: routing after the gate
   * would read zero pending, the batch would run inside the open call and the final write would hit version_conflict, leaving the
   * incident inconsistent. So both writes require that no runs row of the incident be without an end.
   */
  private requireNoRunInProgress(incidentId: string): void {
    const { store, clock } = this.d;
    const now = clock.now();
    for (const r of store.listRuns(incidentId).filter((x) => x.endedAt === null)) {
      const ageMs = now.getTime() - Date.parse(r.startedAt);
      if (!this.activeRuns.has(r.id) && ageMs > this.d.runTimeoutMs + RUN_LEASE_MARGIN_MS) {
        store.recordRun({ ...r, endedAt: now.toISOString(), outcome: "abandoned" });
        this.d.logger.warn("run row left open by another process closed as abandoned", { event: "run_abandoned", incidentId, runId: r.id, startedAt: r.startedAt });
        continue;
      }
      throw new ConflictError("incident_not_accepting", `incident ${incidentId} has a run in progress; try again when it finishes`);
    }
  }

  /**
   * Records every overdue pending approval of the incident as expired (spec 6.5): approval expired with decisionSource
   * expiry, action expired, dependents cancelled and an approval_expired audit entry. Mutates `actions` in place; the
   * caller saves the blackboard. Must run inside the caller's transaction.
   */
  private expireOverdue(incidentId: string, actions: GatedAction[], now: Date, ctx: RunCtx): Approval[] {
    const { store } = this.d;
    const expired: Approval[] = [];
    for (const ap of store.listApprovals({ incidentId, status: "pending" }).filter((a) => isExpired(a, now))) {
      const current = store.getApproval(ap.id)!;
      if (current.status !== "pending") continue; // already closed in cascade in this same transaction
      const next = this.closeApproval(current, { type: "expire" }, now);
      expired.push(next);
      store.appendAudit({
        incidentId, actor: "system:approval-expiry", event: "approval_expired", tier: 3,
        details: { approvalId: next.id, actionId: next.actionId, expiresAt: next.expiresAt, requestId: ctx.requestId },
      });
      const action = actions.find((a) => a.id === next.actionId);
      if (action) {
        action.status = "expired";
        store.upsertAction(action);
        this.cancelDependents(actions, action, "expired", now, ctx, { type: "expire" });
      }
    }
    return expired;
  }

  /**
   * A run stopped outside the graph (timeout or recursion limit) is escalated, so nothing will ever execute its batch.
   * Every still-pending approval is closed (expired, with the cause in the audit) and its action cancelled, so no human
   * can "approve" an action that will never run.
   */
  private closePendingOnStop(incidentId: string, bb: Blackboard, stop: Escalation, ctx: RunCtx): Blackboard {
    const { store, clock } = this.d;
    return store.transaction(() => {
      const now = clock.now();
      const actions = bb.actions.map((a) => ({ ...a }));
      const cause = `incident escalated before a decision (${stop.reason})`;
      for (const ap of store.listApprovals({ incidentId, status: "pending" })) {
        const next = this.closeApproval(ap, { type: "expire" }, now);
        store.appendAudit({
          incidentId, actor: "system:incident-service", event: "approval_expired", tier: 3,
          details: { approvalId: next.id, actionId: next.actionId, cause, requestId: ctx.requestId },
        });
        // The abort can land mid-superstep, after the gate wrote its rows but before its state reached `bb`: fall back
        // to the stored action so it is cancelled either way.
        const action = actions.find((a) => a.id === next.actionId) ?? store.listActions(incidentId).find((a) => a.id === next.actionId);
        if (action && CANCELLABLE.includes(action.status)) {
          action.status = "cancelled";
          action.resultSummary = `cancelled: ${cause}`;
          store.upsertAction(action);
        }
      }
      return { ...bb, actions };
    });
  }

  /** Incident approvals with effective status pending. */
  private pendingCount(incidentId: string, now: Date): number {
    return this.d.store.listApprovals({ incidentId }).filter((a) => effectiveStatus(a, now) === "pending").length;
  }

  /** Applies the transition and writes with optimistic version; a refused transition is a defect of the caller. */
  private closeApproval(a: Approval, ev: Parameters<typeof transition>[1], now: Date): Approval {
    let next = transition(a, ev, now);
    if (next instanceof ApprovalTransitionError && next.code === "expired") next = transition(a, { type: "expire" }, now);
    if (next instanceof ApprovalTransitionError) throw new ConflictError("approval_not_pending", `approval ${a.id} is not pending`);
    this.d.store.transitionApproval(a.id, next, a.version);
    return next;
  }

  /**
   * Cancels the steps that depend on `root` (dependsOn, transitively). A dependent that was waiting for its own
   * approval has the request closed too (rejected by cascade or expired), so no request without an object stays pending.
   */
  private cancelDependents(
    actions: GatedAction[],
    root: GatedAction,
    why: string,
    now: Date,
    ctx: RunCtx,
    cascade: { type: "reject"; approver: string; source: "structured" | "text" } | { type: "expire" },
  ): void {
    const { store } = this.d;
    const queue = [root];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const a of actions) {
        if (!a.dependsOn.includes(parent.order) || !CANCELLABLE.includes(a.status)) continue;
        a.status = "cancelled";
        a.resultSummary = `cancelled: depends on step ${parent.order} (${parent === root ? why : ACTION_STATUS_LABELS.cancelled})`;
        store.upsertAction(a);
        store.appendAudit({
          incidentId: a.incidentId, actor: "system:approval-service", event: "action_cancelled", tier: a.tier,
          details: { actionId: a.id, order: a.order, actionType: a.actionType, dependsOn: a.dependsOn, cause: root.approvalId, requestId: ctx.requestId },
        });
        const own = a.approvalId ? store.getApproval(a.approvalId) : null;
        if (own && own.status === "pending") {
          const comment = `cancelled in cascade: depends on ${root.approvalId ?? `step ${root.order}`} (${why})`;
          const next = this.closeApproval(own, cascade.type === "reject" ? { type: "reject", approver: cascade.approver, comment, source: cascade.source } : { type: "expire" }, now);
          store.appendAudit({
            incidentId: a.incidentId, actor: "system:approval-service", event: next.status === "rejected" ? "approval_rejected" : "approval_expired", tier: a.tier,
            details: { approvalId: next.id, actionId: a.id, cascadeFrom: root.approvalId, requestId: ctx.requestId },
          });
        }
        queue.push(a);
      }
    }
  }

  /**
   * Action proposal coming from outside the team (MCP server, spec 5.4; AC-35 and AC-36). Same path as the gate:
   * classifyAction (tier by code only, blast radius raises the tier), parameters by the catalog and dry run on the
   * current world of the blackboard. Tier 2 becomes ready and tier 3 creates a pending approval; both run on the resume
   * triggered by the last human decision, together with the batch. Tier 4, unknown type, invalid parameters and failed dry run
   * are recorded and audited and become UnprocessableError with a short reason. Never executes or triggers a resume.
   * All in one transaction, with the blackboard version read before the dry run (divergent version: ConflictError).
   */
  proposeExternalAction(input: ProposeRemediationInput, actor: string): ProposeRemediationResult {
    const parsed = parseWithIssues(ProposeRemediationInputSchema, input);
    if (!parsed.success) throw new ValidationError(`invalid input: ${parsed.issues.map((x) => x.path).join(", ")}`, parsed.issues);
    const i = parsed.data;
    const { store, clock, ids } = this.d;
    const incident = this.requireIncident(i.incidentId);
    const { blackboard, version } = store.loadBlackboard(i.incidentId);
    this.requireAcceptingProposals(incident, blackboard);

    const cls = classifyAction(
      { actionType: i.actionType, target: i.target, params: i.params, runbookRef: i.runbookRef ?? null },
      {
        scope: { service: blackboard.alert.service, account: blackboard.alert.account, incidentId: i.incidentId },
        revisionsExhausted: false,
        knownRunbookRefs: runbookRefsOf(blackboard.runbookMatches),
      },
    );
    const head = `${i.actionType} tier ${cls.tier}`;
    let status: GatedAction["status"];
    let event: AuditEvent;
    let summary: string;
    let dryRun: DryRunResult | null = null;
    let refusal: { code: string; message: string } | null = null;
    if (cls.tier === 4 || !isExecutable(i.actionType)) {
      status = cls.known ? "blocked_forbidden" : "blocked_unknown";
      event = cls.known ? "action_blocked_forbidden" : "action_blocked_unknown";
      summary = `${head}: blocked without dry run (${cls.reasons.join("; ")})`;
      refusal = cls.known
        ? { code: "action_forbidden", message: `action refused: ${i.actionType} is forbidden by construction (tier 4)` }
        : { code: "action_unknown", message: `action refused: ${i.actionType} is not in the catalog (deny by default)` };
    } else if (!cls.paramsOk || cls.params === null) {
      const expected = EXECUTABLE_ACTIONS[i.actionType].paramsText;
      status = "rejected_invalid_params";
      event = "action_rejected_invalid_params";
      summary = `${head}: invalid parameters, expected ${expected}; no dry run`;
      refusal = { code: "invalid_params", message: `invalid parameters for ${i.actionType}: expected ${expected}` };
    } else {
      dryRun = this.d.infra.dryRun(blackboard.world, { actionType: i.actionType, target: i.target, params: cls.params });
      clock.tick(DRY_RUN_SEC);
      if (!dryRun.ok) {
        status = "rejected_by_dry_run";
        event = "action_dry_run_failed";
        summary = `${head}: dry run failed (${dryRun.failureReason})`;
        refusal = { code: "dry_run_failed", message: `dry run failed: ${dryRun.failureReason ?? "reason not provided"}` };
      } else if (cls.tier === 2) {
        status = "ready";
        event = "action_ready";
        summary = `${head}: dry run ok (${dryRun.changes.join("; ")}) → ready, runs with the batch after the decisions`;
      } else {
        status = "awaiting_approval";
        event = "approval_requested";
        summary = `${head}: dry run ok (${dryRun.changes.join("; ")})`;
      }
    }

    const result = store.transaction((): ProposeRemediationResult => {
      const now = clock.now();
      const action: GatedAction = {
        id: ids.action(), incidentId: i.incidentId, planRevision: null, order: Math.max(0, ...blackboard.actions.map((a) => a.order)) + 1,
        actionType: i.actionType, target: i.target, params: cls.params ?? i.params, dependsOn: [],
        tier: cls.tier, classificationReasons: cls.reasons, status, dryRun, approvalId: null,
        proposedBy: "mcp_client", executedAt: null, resultSummary: null,
      };
      let expiresAt: string | null = null;
      if (status === "awaiting_approval") {
        expiresAt = new Date(now.getTime() + this.d.approvalTtlMin * 60_000).toISOString();
        const approval: Approval = {
          id: ids.approval(), incidentId: i.incidentId, actionId: action.id, status: "pending", requestedAt: now.toISOString(), expiresAt,
          decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0,
        };
        store.createApproval(approval);
        action.approvalId = approval.id;
        summary += ` → waiting for ${approval.id}`;
      }
      store.saveBlackboard(i.incidentId, { ...blackboard, actions: [...blackboard.actions, action] }, version);
      store.upsertAction(action);
      const ctx = { incidentId: i.incidentId, runId: blackboard.runId, scenarioId: blackboard.scenarioId, requestId: null, signal: new AbortController().signal };
      this.d.trace.emit(ctx, "mcp_client", { type: "action", payload: { tool: action.actionType, args: actionArgs(action), tier: action.tier } });
      this.d.trace.emit(ctx, "mcp_client", { type: "observation", payload: { tool: action.actionType, ok: refusal === null, summary, evidenceRef: null } });
      if (action.tier === 4) {
        this.d.trace.emit(ctx, "gate", { type: "critique", payload: { by: "gate", verdict: "blocked", feedback: `${action.actionType} on ${action.target}: ${action.classificationReasons.join("; ")}` } });
      }
      store.appendAudit({
        incidentId: i.incidentId,
        actor,
        event,
        tier: action.tier,
        details: {
          actionId: action.id, order: action.order, actionType: action.actionType, target: action.target, status: action.status,
          reasons: action.classificationReasons, proposedBy: "mcp_client", rationale: i.rationale, runbookRef: i.runbookRef ?? null,
          dryRun: dryRun === null ? null : (dryRun.failureReason ?? dryRun.changes.join("; ")),
          ...(action.approvalId ? { approvalId: action.approvalId, expiresAt } : {}),
          requestId: null,
        },
      });
      return { actionId: action.id, tier: action.tier, status: action.status, classificationReasons: action.classificationReasons, dryRun, approvalId: action.approvalId };
    });
    this.d.logger.info("external proposal recorded", { incidentId: i.incidentId, event, actionId: result.actionId, tier: result.tier, status: result.status });
    if (refusal) throw new UnprocessableError(refusal.code, refusal.message);
    return result;
  }

  /** Only an incident awaiting approval receives a proposal (spec 5.4, rule 1). */
  private requireAcceptingProposals(incident: Incident, bb: Blackboard): void {
    if (incident.status !== "awaiting_approval" || bb.phase !== "awaiting_approval") {
      throw new ConflictError("incident_not_accepting", "the incident does not accept proposals in this state");
    }
  }

  get(id: string): IncidentView {
    const incident = this.requireIncident(id);
    const { blackboard } = this.d.store.loadBlackboard(id);
    const approvals = this.d.store.listApprovals({ incidentId: id });
    return toIncidentView(incident, blackboard, approvals, this.d.store.listTrace(id).length, this.d.clock.now());
  }

  list(f: IncidentFilter): IncidentSummary[] {
    return this.d.store.listIncidents(f);
  }

  trace(id: string, f?: TraceFilter): TraceEvent[] {
    this.requireIncident(id);
    return this.d.store.listTrace(id, f);
  }

  audit(id: string): AuditEntryView[] {
    this.requireIncident(id);
    return this.d.store.listAudit(id).map(toAuditEntryView);
  }

  postmortem(id: string): PostmortemDoc {
    this.requireIncident(id);
    const pm = this.d.store.loadBlackboard(id).blackboard.postmortem;
    if (pm === null) throw new ConflictError("postmortem_not_ready", `the post-mortem of incident ${id} has not been generated yet`);
    return pm;
  }

  postmortemMarkdown(id: string): string {
    return renderPostmortemMarkdown(this.postmortem(id));
  }

  private requireIncident(id: string) {
    const incident = this.d.store.getIncident(id);
    if (!incident) throw new NotFoundError("not_found", `incident not found: ${id}`);
    return incident;
  }

  /**
   * One graph invocation (spec 4.5): stream of states with recursionLimit and AbortSignal.timeout; keeps the last
   * emitted state. Recursion or timeout become escalation over that state, with the escalation and reporter nodes
   * called directly (no LLM). Fixture errors and defects propagate. At the end: blackboard with version, derived status,
   * incident_resolved audit and the row in runs.
   */
  private async run(incidentId: string, ctx: RunCtx): Promise<Blackboard> {
    const runId = this.d.ids.run();
    this.activeRuns.add(runId);
    try {
      return await this.runWithId(incidentId, ctx, runId);
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async runWithId(incidentId: string, ctx: RunCtx, runId: string): Promise<Blackboard> {
    const { store, clock, limits } = this.d;
    const { blackboard, version } = store.loadBlackboard(incidentId);
    const log = this.d.logger.child({ requestId: ctx.requestId, incidentId, runId });
    const startedAt = clock.now().toISOString();
    const t0 = Date.now();
    store.recordRun({ id: runId, incidentId, startedAt, endedAt: null, outcome: null });
    log.info("run started", { event: "run_started", phase: blackboard.phase });
    /** Closes the row in runs with the error name (never left without an end) and returns the error for the caller to rethrow. */
    const failRun = (e: unknown, msg: string): unknown => {
      store.recordRun({ id: runId, incidentId, startedAt, endedAt: clock.now().toISOString(), outcome: `error: ${(e as Error)?.name ?? "unknown"}`.slice(0, 60) });
      log.error(msg, { event: "run_failed", error: (e as Error)?.name, latencyMs: Date.now() - t0 });
      return e;
    };

    // AbortSignal.timeout only fires when the event loop runs timers. A run without I/O (fake with no delay, synchronous SQLite,
    // awaits in microtasks) never yields, so the deadline is also checked against the clock on each emitted state:
    // the cap holds at superstep granularity anyway.
    const deadline = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(this.d.runTimeoutMs), deadline.signal]);
    const config: NodeConfig = { configurable: { requestId: ctx.requestId } };
    let last: Blackboard = { ...blackboard, runId };
    let stop: Escalation | null = null;
    try {
      const stream = await this.d.graph.stream(last, { streamMode: "values", recursionLimit: limits.recursionLimit, signal, configurable: { requestId: ctx.requestId } });
      for await (const state of stream) {
        last = state;
        if (!signal.aborted && Date.now() - t0 > this.d.runTimeoutMs) {
          deadline.abort(new DOMException(`the run exceeded ${this.d.runTimeoutMs} ms`, "TimeoutError"));
        }
        if (signal.aborted) throw signal.reason;
      }
    } catch (e) {
      if (e instanceof GraphRecursionError) {
        stop = { reason: "recursion_limit", detail: `the invocation exceeded the graph limit of ${limits.recursionLimit} supersteps` };
      } else if (signal.aborted) {
        stop = { reason: "timeout", detail: `the run exceeded ${this.d.runTimeoutMs} ms` };
      } else {
        throw failRun(e, "run interrupted by an error");
      }
    }
    if (stop) {
      log.warn("run escalated outside the graph", { event: "run_escalated", reason: stop.reason });
      last = this.closePendingOnStop(incidentId, { ...last, escalation: stop }, stop, ctx);
      last = { ...last, ...(await this.d.direct.escalation(last, config)) };
      last = { ...last, ...(await this.d.direct.reporter(last, config)) };
    }

    let status: IncidentStatus;
    try {
      status = this.persist(incidentId, last, version, ctx);
    } catch (e) {
      throw failRun(e, "final save of the run failed");
    }
    store.recordRun({ id: runId, incidentId, startedAt, endedAt: clock.now().toISOString(), outcome: status });
    log.info("run finished", { event: "run_finished", outcome: status, latencyMs: Date.now() - t0 });
    return last;
  }

  /** Saves the blackboard with the expected version, derives and writes the status and audits the resolution. */
  private persist(incidentId: string, bb: Blackboard, expectedVersion: number, ctx: RunCtx): IncidentStatus {
    const { store, clock } = this.d;
    return store.transaction(() => {
      const before = this.requireIncident(incidentId);
      store.saveBlackboard(incidentId, bb, expectedVersion);
      const now = clock.now();
      const approvals = store.listApprovals({ incidentId }).map((a) => effectiveStatus(a, now));
      const status = deriveIncidentStatus(bb, approvals);
      const mttrMin = bb.metrics?.mttrMin ?? null;
      store.updateIncidentStatus(incidentId, status, {
        resolvedAt: status === "resolved" ? (bb.metrics?.resolvedAt ?? now.toISOString()) : null,
        escalation: bb.escalation,
        mttrMin,
      });
      if (status === "resolved" && before.status !== "resolved") {
        store.appendAudit({ incidentId, actor: "system:incident-service", event: "incident_resolved", tier: null, details: { mttrMin, requestId: ctx.requestId } });
      }
      return status;
    });
  }
}
