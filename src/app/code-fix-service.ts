// The code fixer job (spec 009, decisions 1 to 4, 16, 17 and 19; AC-60, AC-61, AC-66, AC-74, AC-75, AC-81, AC-82).
// `consider` runs the deterministic eligibility inline, records a skipped row or takes the (repo, errorGroupId) key,
// and hands the attempt to CodeFixQueue; it never throws and never awaits the attempt. The attempt streams its own
// graph and writes the `code_fix_attempts` row at stage boundaries with an optimistic version. It reads the incident
// blackboard once and never writes it: no runs row, no run slot, no incident status change. Nothing here throws into
// the queue: a graph error ends the attempt as gave_up, and the workspace is disposed in a `finally` whatever happens.
import { createHash, randomBytes } from "node:crypto";
import { GraphRecursionError } from "@langchain/langgraph";
import type { Approval, AuditEvent, CodeFixAttempt, CodeFixReason, CodeFixStatus } from "../contracts/index.ts";
import { evaluateEligibility, parseIssueFingerprint } from "../domain/code-fix/eligibility.ts";
import type { ConnectorQueryFeatures, EligibilityInput, EligibilityResult } from "../domain/code-fix/eligibility.ts";
import type { CodeFixLimits } from "../domain/code-fix/limits.ts";
import type { CodeHostReader, GitWorkspacePort, SandboxRunner, Workspace } from "../domain/code-fix/ports.ts";
import { isSkipReason, isTransientReason } from "../domain/code-fix/reasons.ts";
import { effectiveStatus, isExpired, transition } from "../domain/approval/approval-machine.ts";
import { ApprovalTransitionError, ConflictError, NotFoundError } from "../domain/errors.ts";
import { buildCodeFixGraph, CODE_FIX_RECURSION_LIMIT } from "../graph/code-fix/graph.ts";
import type { CodeFixGraphNodes } from "../graph/code-fix/graph.ts";
import { createFixAuthorPatchNode } from "../graph/code-fix/nodes/fix-author-patch-node.ts";
import { createFixAuthorTestNode } from "../graph/code-fix/nodes/fix-author-test-node.ts";
import { createFixBaselineNode } from "../graph/code-fix/nodes/fix-baseline-node.ts";
import { createFixEligibilityNode } from "../graph/code-fix/nodes/fix-eligibility-node.ts";
import { createFixFinalizeNode } from "../graph/code-fix/nodes/fix-finalize-node.ts";
import { createFixGiveUpNode } from "../graph/code-fix/nodes/fix-give-up-node.ts";
import { createFixGuardPatchNode } from "../graph/code-fix/nodes/fix-guard-patch-node.ts";
import { createFixGuardTestNode } from "../graph/code-fix/nodes/fix-guard-test-node.ts";
import { createFixLocateNode } from "../graph/code-fix/nodes/fix-locate-node.ts";
import { createFixReproNode } from "../graph/code-fix/nodes/fix-repro-node.ts";
import { createFixReviewNode } from "../graph/code-fix/nodes/fix-review-node.ts";
import { createFixVerifyNode } from "../graph/code-fix/nodes/fix-verify-node.ts";
import { createFixWorkspaceNode } from "../graph/code-fix/nodes/fix-workspace-node.ts";
import { createCodeFixSession, initialCodeFixState } from "../graph/code-fix/state.ts";
import type { CodeFixRepoConfig, CodeFixSession, CodeFixState, FixConnectorQuery } from "../graph/code-fix/state.ts";
import type { NodeConfig } from "../graph/run-context.ts";
import type { SqliteCodeFixStore } from "../infra/db/code-fix-store.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Clock } from "../infra/clock.ts";
import type { Ids } from "../infra/ids.ts";
import type { Logger } from "../infra/logger.ts";
import type { CodeFixNotificationKind } from "../notifiers/types.ts";
import { redactSecrets, redactThenClip } from "../infra/redact.ts";
import type { CodeFixConfig } from "../infra/copilot-config/schema.ts";
import { anchorChecks } from "../infra/code-fix/git-workspace.ts";
import { readConventions } from "../infra/code-fix/conventions.ts";
import type { LlmProvider, RunContext } from "../llm/provider.ts";
import { createCodeFixQueue } from "./code-fix-queue.ts";
import type { CodeFixQueue } from "./code-fix-queue.ts";
import type { TraceSink } from "./trace-sink.ts";

const ACTOR = "agent:code_fixer";
const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Hex SHA-256 of the UTF-8 text (the fixer's patch hash). */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `fix_` plus 16 lowercase hex characters (CodeFixAttemptSchema: ^fix_[a-z0-9]{8,40}$). */
export const newAttemptId = (): string => `fix_${randomBytes(8).toString("hex")}`;

/** https clone URL of an allowlisted `owner/name`: github.com for the public API, the API host for GitHub Enterprise. */
export function cloneUrlFor(apiUrl: string, repo: string): string {
  const u = new URL(apiUrl);
  const host = u.hostname === "api.github.com" ? "github.com" : u.host;
  return `https://${host}/${repo}.git`;
}

// ---------- node wiring ----------

/** What the real nodes are built from; the session and the decided eligibility input are per attempt. */
export type CodeFixNodeDeps = {
  config: Pick<CodeFixConfig, "repositories" | "fixableExceptionTypes" | "github">;
  limits: CodeFixLimits;
  /** The recording provider (decision 18). */
  llm: LlmProvider;
  redact: (text: string) => string;
  sha256: (text: string) => string;
  now: () => Date;
  query: (connectorId: string) => FixConnectorQuery | null;
  serviceAlias: (connectorId: string, service: string) => string;
  reader: Pick<CodeHostReader, "commitExists">;
  git: GitWorkspacePort;
  sandboxFor: (ws: Workspace) => SandboxRunner;
};

export type AttemptNodeContext = { session: CodeFixSession; eligibilityInput: EligibilityInput };

/** The 13 fixer nodes over one attempt's session. No writer: the fixer graph cannot write to the code host (decision 3). */
export function createCodeFixNodes(d: CodeFixNodeDeps, x: AttemptNodeContext): CodeFixGraphNodes {
  const { session } = x;
  const limits = d.limits;
  const repositories: CodeFixRepoConfig[] = d.config.repositories.map((r) => ({ ...r }));
  return {
    fix_eligibility: createFixEligibilityNode({ repositories, eligibilityInput: () => x.eligibilityInput }),
    fix_locate: createFixLocateNode({
      query: d.query, reader: d.reader, fixableExceptionTypes: d.config.fixableExceptionTypes, now: d.now, serviceAlias: d.serviceAlias,
    }),
    fix_workspace: createFixWorkspaceNode({
      git: d.git,
      session,
      sandboxFor: d.sandboxFor,
      cloneUrl: (repo) => cloneUrlFor(d.config.github.apiUrl, repo),
      token: d.config.github.token,
      checkAnchor: anchorChecks,
      readConventions,
    }),
    fix_baseline: createFixBaselineNode({ session, limits }),
    fix_author_test: createFixAuthorTestNode({ llm: d.llm, redact: d.redact }),
    fix_guard_test: createFixGuardTestNode({ session, limits }),
    fix_repro: createFixReproNode({ session, limits }),
    fix_author_patch: createFixAuthorPatchNode({ llm: d.llm, redact: d.redact }),
    fix_guard_patch: createFixGuardPatchNode({ session, limits }),
    fix_verify: createFixVerifyNode({ session, limits, sha256: d.sha256, redact: d.redact }),
    fix_review: createFixReviewNode({ llm: d.llm, redact: d.redact }),
    fix_finalize: createFixFinalizeNode({ sha256: d.sha256, now: d.now }),
    fix_give_up: createFixGiveUpNode({ limits, redact: d.redact }),
  };
}

// ---------- service ----------

export type SandboxSelfTestOutcome = { ok: boolean; failed?: readonly string[] };

export type CodeFixServiceDeps = {
  store: SqliteIncidentStore;
  fixes: SqliteCodeFixStore;
  config: CodeFixConfig;
  /** effectiveLimits(config.limits). */
  limits: CodeFixLimits;
  clock: Clock;
  ids: Pick<Ids, "approval">;
  logger: Logger;
  trace: TraceSink;
  secrets: readonly string[];
  /** Which optional query members a connector instance has (undefined: unknown connector). */
  connectorFeatures: (connectorId: string) => ConnectorQueryFeatures | undefined;
  nodesFor: (x: AttemptNodeContext) => CodeFixGraphNodes;
  /** The sandbox self-test (decision 7); run once, at start. */
  selfTest: () => Promise<SandboxSelfTestOutcome>;
  /** The publisher's entry point for an approved or publishing attempt (T18); absent until a writer exists. */
  publish?: (attemptId: string) => Promise<void>;
  /**
   * The opt-in code-fix notifications (AC-83): code_fix_ready at patch_ready or awaiting_approval, code_fix_pr_opened
   * when the publish opened the pull request. It reads the attempt and never changes it; a throw or rejection is logged.
   */
  notify?: (kind: CodeFixNotificationKind, attemptId: string) => Promise<void> | void;
  newAttemptId?: () => string;
};

type Ctx = { requestId: string | null };

/** A human decision on a code-fix approval; approver and comment are already redacted by ApprovalService. */
export type CodeFixDecisionInput = {
  decision: "approve" | "reject";
  approver: string;
  comment: string | null;
  source: "structured" | "text";
};

const terminal = (s: CodeFixState["outcome"]["status"]) => s !== "running";

export class CodeFixService {
  readonly store: SqliteCodeFixStore;
  readonly queue: CodeFixQueue;
  private readonly d: CodeFixServiceDeps;
  private readonly log: Logger;
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  /** Attempts this process is running; recover() never touches them. */
  private readonly active = new Set<string>();
  private readonly publishing = new Set<string>();
  private started: Promise<void> | null = null;
  private sandboxAvailable = false;

  constructor(d: CodeFixServiceDeps) {
    this.d = d;
    this.store = d.fixes;
    this.log = d.logger.child({ component: "code_fixer" });
    this.queue = createCodeFixQueue({ concurrency: d.limits.maxConcurrent, logger: this.log });
  }

  private redact(text: string): string {
    return redactSecrets(text, this.d.secrets);
  }

  /** Runs the sandbox self-test once; a failure or a throw leaves the fixer disabled (every eligible incident skipped). */
  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      try {
        const r = await this.d.selfTest();
        this.sandboxAvailable = r.ok === true;
        if (!this.sandboxAvailable) {
          this.log.warn("sandbox self-test failed: the code fixer is disabled", {
            event: "code_fix_sandbox_unavailable", network: this.d.config.sandbox.network, failed: [...(r.failed ?? [])],
          });
        }
      } catch (e) {
        this.sandboxAvailable = false;
        this.log.warn("sandbox self-test failed: the code fixer is disabled", { event: "code_fix_sandbox_unavailable", error: (e as Error)?.name ?? "Error" });
      }
    })();
    return this.started;
  }

  /** Aborts running attempts (shutdown); they end as interrupted. */
  close(): void {
    this.shutdown.abort();
  }

  /** Resolves when no consider is pending and the queue is empty. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.pending.size > 0) {
        await Promise.allSettled([...this.pending]);
        continue;
      }
      await this.queue.idle();
      if (this.pending.size === 0 && this.queue.size() === 0) return;
    }
  }

  /** The latest attempt of an incident, or null. */
  latest(incidentId: string): CodeFixAttempt | null {
    return this.store.latestForIncident(incidentId);
  }

  /** Never throws and never awaits the attempt (decision 1). */
  consider(incidentId: string, ctx: Ctx = { requestId: null }): void {
    try {
      const p: Promise<void> = (async () => {
        await this.start();
        this.considerNow(incidentId, ctx);
      })()
        .catch((e: unknown) => {
          this.log.error("code-fix consider failed", { event: "code_fix_consider_failed", incidentId, error: (e as Error)?.name ?? "Error" });
        })
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    } catch {
      // Nothing to do: consider must never throw into the alert queue's follow-up.
    }
  }

  /** Eligibility, then a skipped row or a running row holding the key, in one transaction; the attempt goes to the queue. */
  private considerNow(incidentId: string, ctx: Ctx): void {
    const { store, fixes, config, clock } = this.d;
    const incident = store.getIncident(incidentId);
    if (!incident) return;
    const { blackboard: bb } = store.loadBlackboard(incidentId);
    const now = clock.now();
    const nowIso = now.toISOString();
    const memo = new Map<string, unknown>();
    const once = <T>(key: string, f: () => T): T => {
      if (!memo.has(key)) memo.set(key, f());
      return memo.get(key) as T;
    };
    const service = bb.alert.service;
    const connectors: Record<string, ConnectorQueryFeatures | undefined> = {};
    for (const r of config.repositories) connectors[r.connector] = this.d.connectorFeatures(r.connector);
    const input: EligibilityInput = {
      status: incident.status,
      escalation: bb.escalation,
      origin: bb.origin,
      diagnosis: bb.diagnosis ? { category: bb.diagnosis.category, confidence: bb.diagnosis.confidence } : null,
      service,
      repositories: config.repositories.map((r) => ({ repo: r.repo, service: r.service, connector: r.connector })),
      connectors,
      sandboxAvailable: this.sandboxAvailable,
      limits: this.d.limits,
      // Read once and frozen, so the graph's own eligibility step decides exactly what was decided here.
      usage: {
        attemptsLast24h: (repo) => once(`day:${repo}`, () => fixes.countStartedSince(repo, new Date(now.getTime() - DAY_MS).toISOString())),
        group: (repo, g) => once(`group:${repo}:${g}`, () => ({ attempts: fixes.countForGroup(repo, g), keyHeld: fixes.holdsKey(repo, g) })),
      },
    };
    const result: EligibilityResult = evaluateEligibility(input);

    const origin = bb.origin ?? null;
    const byService = config.repositories.filter((r) => r.service === service);
    const repoEntry = result.eligible
      ? config.repositories.find((r) => r.repo === result.repository.repo && r.service === result.repository.service)!
      : byService.length === 1 ? byService[0]! : null;
    const errorGroupId = result.eligible ? result.errorGroupId : (origin ? parseIssueFingerprint(origin.fingerprint) : null) ?? "";
    const connectorId = origin && CONNECTOR_ID.test(origin.connectorId) ? origin.connectorId : (repoEntry?.connector ?? "none");
    const base: CodeFixAttempt = {
      id: (this.d.newAttemptId ?? newAttemptId)(),
      incidentId,
      repo: repoEntry?.repo ?? "",
      service: (service ?? "").slice(0, 120),
      connectorId,
      errorGroupId,
      mode: config.mode,
      isolation: config.sandbox.network,
      status: "running",
      stage: "eligibility",
      reason: null,
      violations: [],
      release: null,
      commitSha: null,
      baseBranch: repoEntry?.baseBranch ?? "",
      baseCommitSha: null,
      exception: null,
      anchor: null,
      files: [],
      patch: null,
      patchSha256: null,
      contents: [],
      evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null },
      review: null,
      suggestion: null,
      approvalId: null,
      commit: null,
      pullRequest: null,
      llm: { calls: 0, promptTokens: 0, completionTokens: 0 },
      startedAt: nowIso,
      patchReadyAt: null,
      finishedAt: null,
      version: 0,
    };

    const skip = (reason: CodeFixReason): void => {
      fixes.transaction(() => {
        fixes.insertAttempt({ ...base, status: "skipped", reason, finishedAt: nowIso }, { keyHeld: false });
        this.audit(incidentId, "code_fix_skipped", null, { attemptId: base.id, reason, requestId: ctx.requestId });
      });
      this.log.info("code fix skipped", { event: "code_fix_skipped", incidentId, attemptId: base.id, reason });
    };

    if (!result.eligible) return skip(result.reason);

    let row: CodeFixAttempt;
    try {
      row = fixes.transaction(() => {
        const inserted = fixes.insertAttempt(base, { keyHeld: true });
        this.audit(incidentId, "code_fix_started", null, {
          attemptId: base.id, repo: base.repo, commitSha: null, baseCommitSha: null, isolation: base.isolation, requestId: ctx.requestId,
        });
        return inserted;
      });
    } catch (e) {
      // Another attempt took the key between the read and the insert.
      if (e instanceof ConflictError && e.code === "already_attempted") return skip("already_attempted");
      throw e;
    }
    this.log.info("code fix started", { event: "code_fix_started", incidentId, attemptId: row.id, repo: row.repo });
    this.active.add(row.id);
    const seed = { bbService: service, detectedAt: bb.alert.detectedAt, scenarioId: incident.scenarioId };
    this.queue.enqueue(async () => {
      try {
        await this.runAttempt(row, input, seed, ctx);
      } finally {
        this.active.delete(row.id);
      }
    });
  }

  private audit(incidentId: string, event: AuditEvent, tier: 3 | null, details: Record<string, unknown>): void {
    this.d.store.appendAudit({ incidentId, actor: ACTOR, event, tier, details });
  }

  // ---------- the attempt ----------

  private async runAttempt(
    start: CodeFixAttempt,
    eligibilityInput: EligibilityInput,
    seed: { bbService: string | null; detectedAt: string; scenarioId: string },
    ctx: Ctx,
  ): Promise<void> {
    const session = createCodeFixSession();
    const signal = AbortSignal.any([AbortSignal.timeout(this.d.limits.attemptTimeoutMin * 60_000), this.shutdown.signal]);
    const runCtx: RunContext = { incidentId: start.incidentId, runId: start.id, scenarioId: seed.scenarioId, requestId: ctx.requestId, signal };
    let row = start;
    let detected = seed.detectedAt;
    try {
      detected = new Date(seed.detectedAt).toISOString();
    } catch {
      detected = row.startedAt;
    }
    let state: CodeFixState = initialCodeFixState({
      attemptId: start.id, incidentId: start.incidentId, scenarioId: seed.scenarioId, mode: start.mode, isolation: start.isolation,
      service: seed.bbService, alertStartedAt: detected,
    });
    let nodes: CodeFixGraphNodes | null = null;
    try {
      try {
        nodes = this.d.nodesFor({ session, eligibilityInput });
        const graph = buildCodeFixGraph(nodes, { limits: this.d.limits });
        const stream = await graph.stream(state, { recursionLimit: CODE_FIX_RECURSION_LIMIT, signal, requestId: ctx.requestId });
        let first = true;
        for await (const s of stream) {
          if (first) {
            first = false; // streamMode "values" emits the input state first
            continue;
          }
          this.traceStep(runCtx, state, s);
          state = s;
          if (!terminal(s.outcome.status)) row = this.persist(row, s, {});
        }
      } catch (e) {
        const reason: CodeFixReason = signal.aborted ? "attempt_timeout" : e instanceof GraphRecursionError ? "budget_exhausted" : "sandbox_error";
        this.log.warn("code-fix graph failed", { event: "code_fix_graph_failed", attemptId: row.id, error: (e as Error)?.name ?? "Error", reason });
        state = await this.giveUpOutside(nodes, state, reason, runCtx);
      }
    } finally {
      await this.dispose(session, row.id);
    }
    if (!terminal(state.outcome.status)) state = await this.giveUpOutside(nodes, state, state.failure ?? "sandbox_error", runCtx);
    this.finish(row, state, ctx);
  }

  /** fix_give_up called outside the graph (a throw, recursion), like IncidentService does for the main graph. */
  private async giveUpOutside(nodes: CodeFixGraphNodes | null, state: CodeFixState, reason: CodeFixReason, runCtx: RunContext): Promise<CodeFixState> {
    const failed: CodeFixState = { ...state, failure: reason };
    let next: CodeFixState;
    try {
      if (!nodes) throw new Error("no nodes");
      const cfg: NodeConfig = { signal: runCtx.signal, configurable: { requestId: runCtx.requestId } };
      next = { ...failed, ...(await nodes.fix_give_up(failed, cfg)) };
      if (!terminal(next.outcome.status)) throw new Error("give-up did not end the attempt");
    } catch {
      const skipped = (state.stage === "eligibility" || state.stage === "locate") && isSkipReason(reason);
      next = { ...failed, outcome: { status: skipped ? "skipped" : "gave_up", reason } };
    }
    this.traceStep(runCtx, state, next);
    return next;
  }

  private async dispose(session: CodeFixSession, attemptId: string): Promise<void> {
    const ws = session.workspace;
    session.workspace = null;
    session.sandbox = null;
    if (!ws) return;
    try {
      await ws.dispose();
    } catch (e) {
      this.log.warn("code-fix workspace dispose failed", { event: "code_fix_dispose_failed", attemptId, error: (e as Error)?.name ?? "Error" });
    }
  }

  /** One trace step per superstep: an action and an observation, plus a gate critique for a guard rejection. */
  private traceStep(ctx: RunContext, prev: CodeFixState, s: CodeFixState): void {
    try {
      const ended = !terminal(prev.outcome.status) && (s.outcome.status === "gave_up" || s.outcome.status === "skipped");
      const tool = ended ? "fix_give_up" : `fix_${s.stage}`;
      this.d.trace.emit(ctx, "code_fixer", { type: "action", payload: { tool, args: { attemptId: s.attemptId, stage: s.stage }, tier: null } });
      const violations = s.violations.length > 0 ? ` (${s.violations.join(", ")})` : "";
      const summary = ended
        ? `${s.outcome.status}: ${s.outcome.reason ?? "unknown"} at ${s.stage}${violations}`
        : s.failure === null ? `${s.stage}: ok` : `${s.stage}: ${s.failure}${violations}`;
      this.d.trace.emit(ctx, "code_fixer", { type: "observation", payload: { tool, ok: !ended && s.failure === null, summary, evidenceRef: null } });
      if (!ended && s.failure === "guard_rejected" && (s.stage === "guard_test" || s.stage === "guard_patch")) {
        this.d.trace.emit(ctx, "code_fixer", { type: "critique", payload: { by: "gate", verdict: "reject", feedback: `${s.stage} rejected${violations}` } });
      }
    } catch (e) {
      this.log.warn("code-fix trace failed", { event: "code_fix_trace_failed", attemptId: s.attemptId, error: (e as Error)?.name ?? "Error" });
    }
  }

  /** The row from the state: facts, evidence and artifact; untrusted text redacted. Identity fields never change. */
  private rowOf(row: CodeFixAttempt, s: CodeFixState, status: CodeFixStatus, reason: CodeFixReason | null): CodeFixAttempt {
    const r = (t: string) => this.redact(t);
    return {
      ...row,
      status,
      stage: s.stage,
      reason,
      violations: s.violations.slice(0, 40).map((v) => v.slice(0, 40)),
      release: s.release === null ? null : r(s.release).slice(0, 120),
      commitSha: s.commitSha,
      baseCommitSha: s.baseCommitSha,
      exception: s.exception === null ? null : { type: r(s.exception.type).slice(0, 120), value: redactThenClip(s.exception.value, 300, this.d.secrets) },
      anchor: s.anchor,
      files: s.files,
      patch: s.patch,
      patchSha256: s.patchSha256,
      contents: s.contents,
      evidence: redactSecrets(s.evidence, this.d.secrets),
      review: s.review === null ? null : { verdict: s.review.verdict, concerns: s.review.concerns.map((c) => redactThenClip(c, 200, this.d.secrets)) },
      suggestion: s.suggestion === null ? null : redactSecrets(s.suggestion, this.d.secrets),
      llm: { ...s.llm },
      patchReadyAt: s.patchReadyAt,
    };
  }

  /** Optimistic write of a running row; returns the row at its new version. */
  private persist(row: CodeFixAttempt, s: CodeFixState, o: { status?: CodeFixStatus; reason?: CodeFixReason | null; keyHeld?: boolean; finishedAt?: string | null; approvalId?: string | null }): CodeFixAttempt {
    const next: CodeFixAttempt = {
      ...this.rowOf(row, s, o.status ?? "running", o.reason ?? null),
      ...(o.finishedAt !== undefined ? { finishedAt: o.finishedAt } : {}),
      ...(o.approvalId !== undefined ? { approvalId: o.approvalId } : {}),
    };
    const version = this.d.fixes.updateAttempt(row.id, next, row.version, o.keyHeld === undefined ? {} : { keyHeld: o.keyHeld });
    return { ...next, version };
  }

  /** Writes the end of the attempt and its audit in one transaction; a failure is logged and recover() ends the row later. */
  private finish(row: CodeFixAttempt, s: CodeFixState, ctx: Ctx): void {
    const nowIso = this.d.clock.now().toISOString();
    const fixes = this.d.fixes;
    try {
      if (s.outcome.status === "patch_ready" && s.patchSha256 !== null && s.patch !== null) {
        this.finishPatchReady(row, s, nowIso);
        return;
      }
      // A patch_ready state without its artifact cannot be approved or published: fail closed.
      let reason: CodeFixReason = s.outcome.status === "patch_ready" ? "catalog_refused" : (s.outcome.reason ?? s.failure ?? "sandbox_error");
      // A shutdown abort is reported by the nodes as attempt_timeout; it is an interruption.
      if (reason === "attempt_timeout" && this.shutdown.signal.aborted) reason = "interrupted";
      if (s.outcome.status === "skipped") {
        fixes.transaction(() => {
          this.persist(row, s, { status: "skipped", reason, keyHeld: false, finishedAt: nowIso });
          this.audit(row.incidentId, "code_fix_skipped", null, { attemptId: row.id, reason, requestId: ctx.requestId });
        });
        this.log.info("code fix skipped", { event: "code_fix_skipped", incidentId: row.incidentId, attemptId: row.id, reason });
        return;
      }
      const keyHeld = !isTransientReason(reason);
      fixes.transaction(() => {
        this.persist(row, s, { status: "gave_up", reason, keyHeld, finishedAt: nowIso });
        this.audit(row.incidentId, "code_fix_gave_up", null, { attemptId: row.id, reason, stage: s.stage, violations: s.violations.slice(0, 40) });
      });
      this.log.info("code fix gave up", { event: "code_fix_gave_up", incidentId: row.incidentId, attemptId: row.id, reason, stage: s.stage, keyHeld });
    } catch (e) {
      this.log.error("code-fix attempt could not be recorded", { event: "code_fix_finish_failed", attemptId: row.id, error: (e as Error)?.name ?? "Error" });
    }
  }

  /** Shadow: patch_ready. draft_pr: patch_ready becomes awaiting_approval with the approval row and its audit (decision 19). */
  private finishPatchReady(row: CodeFixAttempt, s: CodeFixState, nowIso: string): void {
    const { fixes, config } = this.d;
    const files = s.files.map((f) => ({ path: f.path, role: f.role, added: f.added, removed: f.removed }));
    const evidence = {
      baselineTotal: s.evidence.baseline?.total ?? 0,
      reproRuns: s.evidence.reproBefore.length,
      reproFailed: s.evidence.reproBefore.filter((x) => x.failed > 0).length,
      fixRuns: s.evidence.fixAfter.length,
      fixPassed: s.evidence.fixAfter.filter((x) => x.outcome === "passed").length,
      suiteTotal: s.evidence.suiteAfter?.total ?? 0,
      suiteFailed: s.evidence.suiteAfter?.failed ?? 0,
    };
    const readyDetails = { attemptId: row.id, patchSha256: s.patchSha256, files, evidence, mode: config.mode, isolation: row.isolation };
    if (config.mode === "shadow") {
      fixes.transaction(() => {
        this.persist(row, s, { status: "patch_ready", finishedAt: nowIso });
        this.audit(row.incidentId, "code_fix_patch_ready", 3, readyDetails);
      });
      this.log.info("code fix patch ready", { event: "code_fix_patch_ready", incidentId: row.incidentId, attemptId: row.id, mode: "shadow" });
      this.notifyFix("code_fix_ready", row.id);
      return;
    }
    const requestedAt = nowIso;
    const expiresAt = new Date(Date.parse(nowIso) + config.approvalTtlHours * 3_600_000).toISOString();
    fixes.transaction(() => {
      const approval: Approval = {
        id: this.d.ids.approval(), incidentId: row.incidentId, actionId: row.id, status: "pending", requestedAt, expiresAt,
        decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0, subject: "code_fix", patchSha256: s.patchSha256 ?? "",
      };
      fixes.insertApproval(approval);
      this.persist(row, s, { status: "awaiting_approval", approvalId: approval.id });
      this.audit(row.incidentId, "code_fix_patch_ready", 3, readyDetails);
      this.audit(row.incidentId, "approval_requested", 3, {
        subject: "code_fix", approvalId: approval.id, attemptId: row.id, patchSha256: approval.patchSha256, expiresAt,
      });
    });
    this.log.info("code fix awaiting approval", { event: "code_fix_awaiting_approval", incidentId: row.incidentId, attemptId: row.id });
    this.notifyFix("code_fix_ready", row.id);
  }

  /** Fires an opt-in notification (AC-83); idle() waits for it. Never throws and never changes the attempt. */
  private notifyFix(kind: CodeFixNotificationKind, attemptId: string): void {
    const notify = this.d.notify;
    if (!notify) return;
    const failed = (e: unknown) => {
      this.log.warn("code-fix notification failed", { event: "code_fix_notify_failed", kind, attemptId, error: (e as Error)?.name ?? "Error" });
    };
    try {
      const p: Promise<void> = Promise.resolve(notify(kind, attemptId)).catch(failed).finally(() => this.pending.delete(p));
      this.pending.add(p);
    } catch (e) {
      failed(e);
    }
  }

  // ---------- restart ----------

  /**
   * On start (decision 2): `running` attempts of a previous process end as gave_up/interrupted with the key released
   * (they are not resumed); `publishing` attempts are re-enqueued, since the publish is idempotent. Never throws.
   */
  recover(): void {
    const { fixes } = this.d;
    try {
      const nowIso = this.d.clock.now().toISOString();
      for (const a of fixes.listByStatus(["running"])) {
        if (this.active.has(a.id)) continue;
        try {
          fixes.transaction(() => {
            const next: CodeFixAttempt = { ...a, status: "gave_up", reason: "interrupted", finishedAt: nowIso };
            fixes.updateAttempt(a.id, next, a.version, { keyHeld: false });
            this.audit(a.incidentId, "code_fix_gave_up", null, { attemptId: a.id, reason: "interrupted", stage: a.stage, violations: a.violations });
          });
          this.log.info("code fix interrupted by a restart", { event: "code_fix_interrupted", incidentId: a.incidentId, attemptId: a.id });
        } catch (e) {
          this.log.error("code-fix recovery failed", { event: "code_fix_recover_failed", attemptId: a.id, error: (e as Error)?.name ?? "Error" });
        }
      }
      // An approved attempt whose publish never started is retried as well: the human already approved it.
      for (const a of fixes.listByStatus(["approved", "publishing"])) this.enqueuePublish(a.id);
    } catch (e) {
      this.log.error("code-fix recovery failed", { event: "code_fix_recover_failed", error: (e as Error)?.name ?? "Error" });
    }
  }

  /** Hands an approved or publishing attempt to the publisher, once at a time per attempt. */
  private enqueuePublish(attemptId: string): void {
    const publish = this.d.publish;
    if (!publish) {
      this.log.warn("code-fix publish pending without a publisher", { event: "code_fix_publish_pending", attemptId });
      return;
    }
    if (this.publishing.has(attemptId)) return;
    this.publishing.add(attemptId);
    this.queue.enqueue(async () => {
      try {
        const before = this.statusOf(attemptId);
        await publish(attemptId);
        if (before !== "pr_opened" && this.statusOf(attemptId) === "pr_opened") this.notifyFix("code_fix_pr_opened", attemptId);
      } finally {
        this.publishing.delete(attemptId);
      }
    });
  }

  private statusOf(attemptId: string): CodeFixStatus | null {
    try {
      return this.d.fixes.getAttempt(attemptId)?.status ?? null;
    } catch {
      return null;
    }
  }

  // ---------- approvals (decision 14) ----------

  /** A code-fix approval by id (stored status), or null. */
  getApproval(id: string): Approval | null {
    return this.d.fixes.getApproval(id);
  }

  /** Every code-fix approval, after materializing the overdue ones (expiry on read). */
  listApprovals(ctx: Ctx = { requestId: null }): Approval[] {
    const { fixes, clock } = this.d;
    const now = clock.now();
    for (const ap of fixes.listApprovals({ status: "pending" })) {
      if (!isExpired(ap, now)) continue;
      try {
        this.expire(ap.id, now, ctx);
      } catch (e) {
        this.log.warn("code-fix approval expiry failed", { event: "code_fix_expiry_failed", approvalId: ap.id, error: (e as Error)?.name ?? "Error" });
      }
    }
    return fixes.listApprovals({}).map((a) => ({ ...a, status: effectiveStatus(a, clock.now()) }));
  }

  /**
   * A human decision (decision 14), with its own expiry and pending checks. Expired: approval and attempt `expired` and
   * `approval_expired` in one transaction, then 409. Otherwise, in one transaction: the approval transition (optimistic
   * version), the attempt `awaiting_approval -> approved | rejected` and the `approval_*` audit. Approval enqueues the
   * publish. It never touches the incident: no blackboard, status, decision, expiry or resume path.
   */
  decide(approvalId: string, input: CodeFixDecisionInput, ctx: Ctx): Approval {
    const { fixes, clock } = this.d;
    const approval = fixes.getApproval(approvalId);
    if (!approval) throw new NotFoundError("not_found", `approval not found: ${approvalId.slice(0, 64)}`);
    const now = clock.now();
    if (isExpired(approval, now)) {
      this.expire(approval.id, now, ctx);
      throw new ConflictError("approval_expired", `approval ${approval.id} expired at ${approval.expiresAt}`);
    }
    if (approval.status !== "pending") throw new ConflictError("approval_not_pending", `approval ${approval.id} was already decided (${approval.status})`);
    const attempt = fixes.getAttempt(approval.actionId);
    if (!attempt || attempt.status !== "awaiting_approval" || attempt.approvalId !== approval.id) {
      throw new ConflictError("code_fix_not_awaiting_approval", `code-fix attempt ${approval.actionId} is not awaiting approval`);
    }
    const next = transition(approval, { type: input.decision, approver: input.approver, comment: input.comment, source: input.source }, now);
    if (next instanceof ApprovalTransitionError) {
      throw next.code === "expired"
        ? new ConflictError("approval_expired", `approval ${approval.id} expired at ${approval.expiresAt}`)
        : new ConflictError("approval_not_pending", `approval ${approval.id} is not pending`);
    }
    const approved = next.status === "approved";
    const nowIso = now.toISOString();
    fixes.transaction(() => {
      fixes.transitionApproval(approval.id, next, approval.version);
      fixes.updateAttempt(attempt.id, { ...attempt, status: approved ? "approved" : "rejected", finishedAt: approved ? null : nowIso }, attempt.version);
      this.d.store.appendAudit({
        incidentId: approval.incidentId,
        actor: `human:${next.approver ?? "unknown"}`,
        event: approved ? "approval_approved" : "approval_rejected",
        tier: 3,
        details: {
          subject: "code_fix", approvalId: approval.id, attemptId: attempt.id, patchSha256: approval.patchSha256 ?? null,
          source: next.decisionSource, comment: next.comment, requestId: ctx.requestId,
        },
      });
    });
    this.log.info("code-fix decision recorded", {
      event: approved ? "approval_approved" : "approval_rejected", incidentId: approval.incidentId, attemptId: attempt.id, approvalId: approval.id,
    });
    if (approved) this.enqueuePublish(attempt.id);
    return fixes.getApproval(approval.id)!;
  }

  /** Materializes one overdue approval, and its attempt when it still awaits it, in one transaction. */
  private expire(approvalId: string, now: Date, ctx: Ctx): void {
    const { fixes } = this.d;
    const nowIso = now.toISOString();
    fixes.transaction(() => {
      const ap = fixes.getApproval(approvalId);
      if (!ap || !isExpired(ap, now)) return;
      const next = transition(ap, { type: "expire" }, now);
      if (next instanceof ApprovalTransitionError) return;
      fixes.transitionApproval(ap.id, next, ap.version);
      const attempt = fixes.getAttempt(ap.actionId);
      if (attempt && attempt.status === "awaiting_approval" && attempt.approvalId === ap.id) {
        fixes.updateAttempt(attempt.id, { ...attempt, status: "expired", finishedAt: nowIso }, attempt.version);
      }
      this.d.store.appendAudit({
        incidentId: ap.incidentId, actor: "system:approval-service", event: "approval_expired", tier: 3,
        details: {
          subject: "code_fix", approvalId: ap.id, attemptId: ap.actionId, source: "expiry", comment: null, expiresAt: ap.expiresAt, requestId: ctx.requestId,
        },
      });
    });
    this.log.info("code-fix approval expired", { event: "approval_expired", approvalId });
  }
}
