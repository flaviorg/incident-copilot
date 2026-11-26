// Code fixer eligibility (spec 009, decisions 4 and 16): deterministic and deny by default. A failure is a `skipped`
// attempt with a typed reason, decided with no LLM call, no git and no code-host request. Pure: no node imports.
import type { Confidence, Escalation, IncidentOrigin, IncidentStatus, RootCauseCategory } from "../../contracts/index.ts";
import type { CodeFixLimits } from "./limits.ts";

/** The slice of an allowlisted repository entry eligibility needs. */
export type EligibilityRepository = { repo: string; service: string; connector: string };

/** Which optional query members a connector instance has. */
export type ConnectorQueryFeatures = { errorEvent: boolean; releaseCommit: boolean; deploys: boolean };

/** Attempt counters, read only once every earlier check passed (the caller backs them with the store). */
export type EligibilityUsage = {
  /** Attempts of the repository that entered `running` in the last 24 hours. */
  attemptsLast24h(repo: string): number;
  /** Rows of the error group (skipped rows excluded by the caller) and whether one of them holds the key. */
  group(repo: string, errorGroupId: string): { attempts: number; keyHeld: boolean };
};

export type EligibilityInput = {
  status: IncidentStatus;
  escalation: Escalation | null;
  /** Absent for a scenario incident. */
  origin: IncidentOrigin | null | undefined;
  diagnosis: { category: RootCauseCategory; confidence: Confidence } | null;
  /** `alert.service` of the blackboard. */
  service: string | null;
  repositories: readonly EligibilityRepository[];
  connectors: Readonly<Record<string, ConnectorQueryFeatures | undefined>>;
  /** The sandbox self-test passed (or `best_effort` was chosen explicitly). */
  sandboxAvailable: boolean;
  limits: Pick<CodeFixLimits, "maxAttemptsPerDay" | "maxAttemptsPerGroup">;
  usage: EligibilityUsage;
};

export type EligibilitySkipReason =
  | "not_advised" | "source_unsupported" | "category_not_code" | "low_confidence" | "service_not_allowlisted"
  | "connector_unsupported" | "sandbox_unavailable" | "daily_cap_reached" | "already_attempted";

export type EligibilityResult =
  | { eligible: true; repository: EligibilityRepository; errorGroupId: string }
  | { eligible: false; reason: EligibilitySkipReason };

const ISSUE_FINGERPRINT = /^issue:(\d{1,20})$/;

/** The Sentry issue id from an origin fingerprint set by the Sentry ingest code, or null. */
export function parseIssueFingerprint(fingerprint: string): string | null {
  const m = ISSUE_FINGERPRINT.exec(fingerprint);
  return m ? m[1]! : null;
}

/** Checks in the order of decision 4; the first failing check names the reason. */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const skip = (reason: EligibilitySkipReason): EligibilityResult => ({ eligible: false, reason });

  if (input.status !== "advised" || input.escalation !== null) return skip("not_advised");

  const origin = input.origin;
  if (!origin || origin.kind !== "connector" || origin.source !== "sentry") return skip("source_unsupported");
  const errorGroupId = parseIssueFingerprint(origin.fingerprint);
  if (errorGroupId === null) return skip("source_unsupported");

  const diagnosis = input.diagnosis;
  if (!diagnosis || diagnosis.category !== "bad_deploy") return skip("category_not_code");
  if (diagnosis.confidence !== "medium" && diagnosis.confidence !== "high") return skip("low_confidence");

  if (input.service === null) return skip("service_not_allowlisted");
  const matches = input.repositories.filter((r) => r.service === input.service);
  if (matches.length !== 1) return skip("service_not_allowlisted");
  const repository = matches[0]!;

  // The error id belongs to the incident's connector, so the repository must read through that same connector.
  if (repository.connector !== origin.connectorId) return skip("connector_unsupported");
  const features = Object.hasOwn(input.connectors, repository.connector) ? input.connectors[repository.connector] : undefined;
  if (!features || features.errorEvent !== true || features.releaseCommit !== true || features.deploys !== true) {
    return skip("connector_unsupported");
  }

  if (input.sandboxAvailable !== true) return skip("sandbox_unavailable");

  if (input.usage.attemptsLast24h(repository.repo) >= input.limits.maxAttemptsPerDay) return skip("daily_cap_reached");

  const group = input.usage.group(repository.repo, errorGroupId);
  if (group.keyHeld || group.attempts >= input.limits.maxAttemptsPerGroup) return skip("already_attempted");

  return { eligible: true, repository, errorGroupId };
}
