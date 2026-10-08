# 003: Supervisor team

Milestone M3. Status: implemented.

## Context

A real incident needs more than one role: investigate, find the procedure, plan, review the plan and report. This milestone assembles the team in a LangGraph `StateGraph`:

- a supervisor that only orchestrates;
- specialists built by factories with dependency injection;
- a Zod blackboard as the single state.

The LLM picks the next specialist, but code validates the choice, enforces the caps and decides every escalation.

## Scope

- Blackboard (`BlackboardSchema`) and graph (`src/graph/graph.ts`), with pure routes in `src/graph/routing.ts` and an explicit `pathMap`.
- `supervisor` node:
  - checks the caps before the LLM;
  - goes through the precondition guard (`guardChoice` in `src/domain/supervisor/supervisor-guard.ts`), and an invalid choice becomes a `critique` with `verdict: "coerced"`;
  - records handoff and history.
- `runbook_retriever` node (BM25, no LLM and no repetition), `remediation_planner` node (sees the catalog as text, no tools) and `auditor` node, with code rules as the floor, the LLM verdict and up to 2 revisions (Reflection).
- `reporter` node:
  - pure metrics;
  - code-generated timeline;
  - LLM narrative passed through the numeric guard;
  - deterministic template when the guard rejects it or the incident escalates.
- `escalation` node, no LLM.
- `IncidentService`:
  - opens the incident;
  - runs the graph via `stream` with `recursionLimit` and `AbortSignal.timeout`;
  - keeps the last state;
  - derives and persists the status (`deriveIncidentStatus`).
- Container with all services.

## Non-goals

- LangGraph checkpointer and `interrupt()`: the pause persists the blackboard in SQLite and resuming is a new invocation.
- LangGraph Studio and `langgraph.json`.
- Strategy router (ReAct, Plan-and-Execute and Reflection as routes chosen by the model).
- Judge pattern with two opinions and the Agent-to-Agent protocol.
- LLM-chosen escalation: `SupervisorDecisionSchema` has no such option.

## Acceptance criteria (EARS)

- **AC-02** The system shall record a `handoff` event for each supervisor decision, for each specialist return to the supervisor and for each transition between gate, human and executor, with `from`, `to`, `brief` and `reason`.
- **AC-03** If the supervisor chooses a step whose preconditions are not met, then the system shall reject the choice, record a `critique` with `by: "supervisor_guard"` and `verdict: "coerced"`, and follow the canonical route.
- **AC-04** If the supervisor is invoked with `supervisor.iterations` above `limits.teamMaxIterations`, then the system shall stop without calling the LLM, mark `escalated` with `team_cap_reached` and generate a `partial` post-mortem from the template.
- **AC-06** If a graph invocation exceeds the recursion limit, then the system shall catch the error, mark `escalated` with `recursion_limit`, keep the recorded trace and preserve in the blackboard the last emitted state (including any diagnosis and plan already obtained).
- **AC-08** When the auditor evaluates a plan, the system shall apply the rules from 4.7 as a floor: an LLM `approve` verdict with a failed rule becomes `revise`, recorded as overridden; `revise` returns to the planner at most 2 times; once revisions are exhausted, all steps are raised to tier 3.
- **AC-09** If the diagnosis still has `low` confidence after 2 analyst rounds, then the system shall escalate with `low_confidence_diagnosis` without calling the planner.
- **AC-23** If the post-mortem narrative contains a number that matches no computed value, timeline value or evidence, then the system shall discard the narrative, use the deterministic template and record a `critique` with `by: "numeric_guard"` listing the rejected numbers.

Auditor rules (design section 4.7):

| Rule | What it requires |
|---|---|
| `snapshot_before_delete` | Every `delete_volume` has a `create_volume_snapshot` on the same target in an earlier step, listed in `dependsOn` |
| `resize_requires_low_cpu` | `resize_instance` to a smaller type requires a 14-day average CPU of at most 10% |
| `release_requires_unassociated` | `release_elastic_ip` requires an unassociated IP |
| `rollback_requires_recent_deploy` | `rollback_deployment` requires a deploy of the same service up to 60 min before the impact and `toVersion` equal to the version before it |
| `depends_on_valid` | Every `dependsOn` points to an existing step with a lower order in the plan |

## How to verify

| Criterion | Tests |
|---|---|
| AC-02 | `tests/e2e/team.e2e.test.ts` ("every supervisor decision and specialist return has a handoff"); `tests/e2e/scenarios.e2e.test.ts` |
| AC-03 | `tests/unit/supervisor-guard.unit.test.ts`; `tests/e2e/team.e2e.test.ts` ("guard coercion keeps the flow going") |
| AC-04 | `tests/e2e/team.e2e.test.ts` ("team cap (limit 3) escalates with a partial template report") |
| AC-06 | `tests/e2e/team.e2e.test.ts` ("recursion limit (5) escalates and keeps the last state") |
| AC-08 | `tests/unit/auditor-rules.unit.test.ts` ("verdict combination: code is the floor"); `tests/e2e/team.e2e.test.ts` ("cost: Reflection sends the plan back once") |
| AC-09 | `tests/e2e/team.e2e.test.ts` ("low confidence after two runs escalates as low_confidence_diagnosis") |
| AC-23 | `tests/unit/numeric-guard.unit.test.ts`; `tests/unit/nodes-reporter.unit.test.ts` (fixture `invented-numbers.json`) |

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "4.5 The graph", with "4.5.1 Code-decided routes" and "4.5.2 Phase and status per node";
- "4.6 Specialists";
- "4.7 Auditor rules: code is the floor";
- "6.2 Caps";
- "6.3 Supervisor guard";
- "8.3 Acceptance criteria in EARS".

Section numbers cited in the criteria (such as "rules from 4.7") point to that document. Diagrams and the route table are in `docs/architecture.md`.
