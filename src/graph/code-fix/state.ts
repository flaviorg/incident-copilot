// Code fixer graph state (spec 009, decisions 2, 5, 6, 8 and 17). LangGraph's default reducer for zod objects keeps the
// last value per key, so each node returns only the keys it changed. Nodes set `stage` when they start and `failure`
// when they end: null on success, a typed reason otherwise. Routes read only this state (and limits), never model text.
// The state holds no secret, no workspace and no sandbox: those live in the per-attempt `CodeFixSession`.
import * as z from "zod";
import {
  CodeFixFileSchema, CodeFixIsolationSchema, CodeFixModeSchema, CodeFixReasonSchema, CodeFixStageSchema, CodeFixSuggestionSchema,
  FixPatchProposalSchema, FixTestProposalSchema, StackFrameSchema, TestRunSummarySchema,
} from "../../contracts/index.ts";
import type { DeployRecord, ErrorEvent, ReleaseCommit } from "../../contracts/index.ts";
import type { QueryIO } from "../../connectors/types.ts";
import type { SandboxRunner, Workspace } from "../../domain/code-fix/ports.ts";
import type { RunContext } from "../../llm/provider.ts";
import type { NodeConfig } from "../run-context.ts";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** The allowlisted repository entry of `copilot.yaml` (no secret: the token stays in the workspace node's deps). */
export const CodeFixRepoConfigSchema = z.object({
  repo: z.string().max(201),
  service: z.string().max(120),
  connector: z.string().max(64),
  baseBranch: z.string().max(300),
  pathPrefixes: z.array(z.string().max(200)).max(10),
  sourceGlobs: z.array(z.string().max(200)).max(20),
  testGlobs: z.array(z.string().max(200)).max(20),
  testFiles: z.array(z.string().max(200)).max(20),
  deniedPaths: z.array(z.string().max(200)).max(50),
});
export type CodeFixRepoConfig = z.infer<typeof CodeFixRepoConfigSchema>;

/** Mirrors `Conventions` of src/infra/code-fix/conventions.ts: sanitized, clipped, untrusted repository text. */
export const FixConventionsSchema = z.object({
  files: z.array(z.object({
    kind: z.enum(["anchor_window", "nearest_test", "package_json", "agents", "contributing"]),
    path: z.string(),
    text: z.string(),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  })),
  totalChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type FixConventions = z.infer<typeof FixConventionsSchema>;

/** Failure facts of the new test as code observed them (name, errorName, frames); never its content or raw output. */
export const FixObservedFailureSchema = z.object({
  name: z.string().max(200),
  errorName: z.string().max(120),
  frames: z.array(z.object({ file: z.string().max(300), line: z.number().int().positive() })).max(10),
});

/** Running until give-up or finalize writes the end: skipped (before the workspace), gave_up or patch_ready. */
export const CodeFixOutcomeSchema = z.object({
  status: z.enum(["running", "skipped", "gave_up", "patch_ready"]),
  reason: CodeFixReasonSchema.nullable(),
});

export const CodeFixStateSchema = z.object({
  // ---- attempt identity (set by the service; never from model text) ----
  attemptId: z.string(),
  incidentId: z.string(),
  scenarioId: z.string(),
  mode: CodeFixModeSchema,
  isolation: CodeFixIsolationSchema,
  /** `alert.service` of the incident. */
  service: z.string().nullable(),
  alertStartedAt: z.iso.datetime(),
  // ---- set by eligibility ----
  repository: CodeFixRepoConfigSchema.nullable(),
  connectorId: z.string().nullable(),
  errorGroupId: z.string().max(40).nullable(),
  // ---- progress ----
  stage: CodeFixStageSchema,
  /** The last node's failure, read by the routes: null on success. */
  failure: CodeFixReasonSchema.nullable(),
  // ---- facts from connector data (locate) and git (workspace) ----
  release: z.string().max(120).nullable(),
  commitSha: sha40.nullable(),
  baseCommitSha: sha40.nullable(),
  exception: z.object({ type: z.string().max(120), value: z.string().max(300) }).nullable(),
  /** The innermost in-app frame with `file` mapped to the repo-relative path. */
  anchor: StackFrameSchema.nullable(),
  /** The event's frames as reported (innermost last), prefixes not stripped. */
  frames: z.array(StackFrameSchema).max(50),
  conventions: FixConventionsSchema.nullable(),
  // ---- authoring ----
  authorTestCalls: z.number().int().nonnegative(),
  authorPatchCalls: z.number().int().nonnegative(),
  llm: z.object({
    calls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }),
  /** Sentences from code (guard violations, repro facts) for the next call of each author. */
  feedback: z.object({ test: z.array(z.string().max(400)).max(40), patch: z.array(z.string().max(400)).max(40) }),
  testProposal: FixTestProposalSchema.nullable(),
  patchProposal: FixPatchProposalSchema.nullable(),
  observedFailure: FixObservedFailureSchema.nullable(),
  /** Guard codes of the last rejection. */
  violations: z.array(z.string().max(40)).max(40),
  // ---- evidence and artifact ----
  evidence: z.object({
    baseline: TestRunSummarySchema.nullable(),
    reproBefore: z.array(TestRunSummarySchema).max(2),
    fixAfter: z.array(TestRunSummarySchema).max(2),
    suiteAfter: TestRunSummarySchema.nullable(),
  }),
  files: z.array(CodeFixFileSchema).max(3),
  patch: z.string().max(20_000).nullable(),
  patchSha256: sha256.nullable(),
  contents: z.array(z.object({ path: z.string().max(300), text: z.string().max(262_144) })).max(3),
  review: z.object({ verdict: z.enum(["approve", "reject"]), concerns: z.array(z.string().max(200)).max(5) }).nullable(),
  suggestion: CodeFixSuggestionSchema.nullable(),
  patchReadyAt: z.iso.datetime().nullable(),
  // ---- end ----
  outcome: CodeFixOutcomeSchema,
});
export type CodeFixState = z.infer<typeof CodeFixStateSchema>;

export type CodeFixStateSeed = Pick<
  CodeFixState, "attemptId" | "incidentId" | "scenarioId" | "mode" | "isolation" | "service" | "alertStartedAt"
>;

/** The state an attempt starts with: nothing located, no LLM usage, running. */
export function initialCodeFixState(seed: CodeFixStateSeed): CodeFixState {
  return {
    ...seed,
    repository: null,
    connectorId: null,
    errorGroupId: null,
    stage: "eligibility",
    failure: null,
    release: null,
    commitSha: null,
    baseCommitSha: null,
    exception: null,
    anchor: null,
    frames: [],
    conventions: null,
    authorTestCalls: 0,
    authorPatchCalls: 0,
    llm: { calls: 0, promptTokens: 0, completionTokens: 0 },
    feedback: { test: [], patch: [] },
    testProposal: null,
    patchProposal: null,
    observedFailure: null,
    violations: [],
    evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null },
    files: [],
    patch: null,
    patchSha256: null,
    contents: [],
    review: null,
    suggestion: null,
    patchReadyAt: null,
    outcome: { status: "running", reason: null },
  };
}

/** A fixer node: state in, partial state out. It never throws for an expected failure; it sets `failure`. */
export type CodeFixNodeFn = (state: CodeFixState, config?: NodeConfig) => Promise<Partial<CodeFixState>>;

/**
 * Per-attempt handles that cannot live in the state: the workspace (set by fix_workspace) and the sandbox runner built
 * for it. The service creates one per attempt and disposes `workspace` in a `finally` block, whatever the outcome.
 */
export type CodeFixSession = { workspace: Workspace | null; sandbox: SandboxRunner | null };

export function createCodeFixSession(): CodeFixSession {
  return { workspace: null, sandbox: null };
}

/** The connector query members the fixer reads (decision 5); not LLM tools. */
export type FixConnectorQuery = {
  errorEvent?(q: { service: string; errorId: string }, io: QueryIO): Promise<ErrorEvent | null>;
  deploys?(q: { service: string; since: Date }, io: QueryIO): Promise<DeployRecord[]>;
  releaseCommit?(q: { service: string; version: string }, io: QueryIO): Promise<ReleaseCommit | null>;
};

/** The LLM run context of an attempt: runId is the attempt id (decision 18). */
export function fixRunContext(state: Pick<CodeFixState, "incidentId" | "attemptId" | "scenarioId">, config?: NodeConfig): RunContext {
  return {
    incidentId: state.incidentId,
    runId: state.attemptId,
    scenarioId: state.scenarioId,
    requestId: config?.configurable?.requestId ?? null,
    signal: config?.signal ?? new AbortController().signal,
  };
}

/** True when the attempt's signal (timeout or shutdown) already fired. */
export function attemptAborted(config?: NodeConfig): boolean {
  return config?.signal?.aborted === true;
}

/** A signal for I/O inside a node: the attempt's, or one that never fires. */
export function signalOf(config?: NodeConfig): AbortSignal {
  return config?.signal ?? new AbortController().signal;
}
