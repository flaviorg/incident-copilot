# 004: Remediation gate

Milestone M4. Status: implemented.

## Context

This is where the project's thesis becomes code: the model proposes the remediation, but what runs is decided by code and, for risky actions, by a human. The gate:

- classifies each step with the Autonomy Matrix;
- runs the dry run in the simulated world;
- requests approval for tier 3;
- blocks tier 4 by construction.

Execution only starts after every decision in the batch has been made. A canary checks recovery and reverts what did not work.

## Scope

- Action catalog and `classifyAction`: catalog tier plus context rules that only raise the tier. The matrix in `docs/autonomy-matrix.md` is generated from the catalog.
- Approval state machine (`transition`, `effectiveStatus`), with expiration projected on read and materialized on decision. `parseDecision`, with a closed list of terms.
- Protections with an injected clock: circuit breaker (3 failures, 300 s), execution limiter (5 per minute, same action on the same target once per 10 min) and token attempt limiter (5 in 10 min lock for 10 min).
- `SimulatedInfra`: dry run, execution, revert and post-action series, with one executor per type in `Record<ExecutableActionType, Executor>`.
- `gate`, `executor` and `verifier` nodes, none of them with an LLM.
- `ApprovalService`:
  - body;
  - configured token;
  - lockout;
  - token;
  - ambiguous text;
  - existence;
  - expiration;
  - status;
  - transition and resume.
- Complete fixtures for the 2 scenarios, metrics golden, log injection test and CLI `demo`.

## Non-goals

- Real infrastructure actions: everything runs on the simulated world.
- Multi-user authentication and RBAC: a single token proves the pattern.
- A scheduler that materializes expiration without a decision attempt (v2 backlog).
- Tier-raising rule based on estimated cost (v2 backlog).
- Catalog actions not used in the v1 scenarios (`scale_out`, `rolling_restart` and others, v2 backlog).
- Any path in which the LLM decides tier, approval or execution.

## Acceptance criteria (EARS)

- **AC-10** The system shall set each step's tier via `classifyAction`, without reading a tier from LLM output, and no context rule may lower the catalog tier.
- **AC-11** When a step is tier 4 or of a type outside the catalog, including when proposed after a log containing an embedded instruction, the system shall block it with no dry run and no queue, with status `blocked_forbidden` or `blocked_unknown`, recording audit and a gate `critique` with `verdict: "blocked"`.
- **AC-12** When the gate processes an executable step, the system shall: on a failed dry run, mark it `rejected_by_dry_run` without creating an approval; on tier 2 with a successful dry run, mark it `ready`; on tier 3 with a successful dry run, create a `pending` approval and leave the incident `awaiting_approval`; and execute no step in the batch before all decisions are made.
- **AC-13** When the decision arrives as free text, the system shall accept only the exact phrases from the approve and reject lists, after normalization, and respond 422 `ambiguous_decision` to any other text, without changing state.
- **AC-14** When a human rejects an approval, the system shall cancel the step and the steps that depend on it, recording success for none of them, and mark the incident `escalated` with `mitigation_rejected` if no mitigating action is executed.
- **AC-15** While a `pending` approval is past due, reads shall show it as `expired` without writing anything; when a decision arrives for it, the system shall materialize the expiration of the incident's overdue approvals, respond 409 `approval_expired` and, with no pending approvals left, resume treating the expiration as a rejection.
- **AC-19** If the circuit breaker is open or the global or per-target execution limit is exceeded, then the system shall mark the step `blocked_circuit_open` or `throttled`, not execute it, and escalate with `circuit_open` or `throttled`.
- **AC-20** When the canary fails after an execution, the system shall revert the executed reversible actions in reverse order, record `canary_rollback`, register a failure in the breaker and escalate with `remediation_ineffective`.
- **AC-24** When the `cost-anomaly` scenario ends with all approvals approved, the system shall report as monthly savings the sum of the savings from the inventory findings of the executed actions, computed from `inventory.json` and `data/cloud-prices.json`.
- **AC-38** When `npm run demo` runs without `--live`, the system shall use the fake provider even with `OPENROUTER_API_KEY` in the environment, complete the default scenario in under 10 seconds with exit code 0 and state in the header that the provider is fake.

Autonomy Matrix (design section 6.4):

| Tier | Rule | v1 actions |
|---|---|---|
| 1 Decides alone | Read-only, zero risk | the 4 read tools |
| 2 Decides and records | Reversible or no effect on the service | `add_incident_note`, `block_image_tag`, `tag_resource_for_review`, `create_volume_snapshot` |
| 3 Requires human approval | Destructive or high impact | `rollback_deployment`, `release_elastic_ip`, `delete_volume`, `resize_instance` |
| 4 Forbidden by construction | Exposes data, deletes audit or backups, disables controls | `delete_audit_log`, `disable_security_scanner`, `export_user_data`, `run_arbitrary_command`, `delete_backups` and any type outside the catalog |

Context rules that raise to tier 3:

- target outside the incident's service or account;
- step without `runbookRef`;
- plan that reached the gate with revisions exhausted.

## How to verify

| Criterion | Tests |
|---|---|
| AC-10 | `tests/unit/autonomy.unit.test.ts` ("context rules only raise", "forbidden and unknown are tier 4") |
| AC-11 | `tests/e2e/injection.e2e.test.ts`; `tests/e2e/scenarios.e2e.test.ts` ("cost approved: Reflection, tier 4 blocked, savings from the inventory") |
| AC-12 | `tests/unit/nodes-gate.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` |
| AC-13 | `tests/unit/parse-decision.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` ("ambiguous text changes nothing; exact text decides") |
| AC-14 | `tests/e2e/gate.e2e.test.ts` ("reject cancels dependents and escalates mitigation_rejected") |
| AC-15 | `tests/unit/approval-machine.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` ("expired approval: reads project it, decision materializes it and answers approval_expired") |
| AC-19 | `tests/unit/guards.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` ("failed dry run, open breaker, full limiter and failing canary end as the spec says") |
| AC-20 | `tests/unit/canary.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` |
| AC-24 | `tests/unit/inventory-audit.unit.test.ts`; `tests/e2e/scenarios.e2e.test.ts` (golden `metrics.cost-anomaly.approved.json`) |
| AC-38 | `tests/e2e/cli.e2e.test.ts` ("demo runs offline with fake provider even with a key in the environment") |

Demonstrable milestone: full `npm run demo`; `npm run demo -- --reject` ends `escalated`; `npm run demo -- --scenario cost-anomaly` shows Reflection, tier 4 blocked and US$ 339.59 in monthly savings.

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "6.4 Autonomy Matrix and action catalog";
- "6.5 Approval state machine";
- "6.7 Circuit breaker, rate limit and canary";
- "6.10 Threat model";
- "8.3 Acceptance criteria in EARS".

State machine in `docs/architecture.md`; threats and defenses in `docs/threat-model.md`; generated matrix in `docs/autonomy-matrix.md`.
