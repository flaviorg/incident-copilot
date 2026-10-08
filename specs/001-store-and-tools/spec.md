# 001: Store and tools

Milestones M0 (Foundation) and M1 (Store and tools). Status: implemented.

## Context

The copilot needs a deterministic base before any agent:

- contracts shared by the backend, MCP and War Room;
- persistence with a tamper-evident audit trail;
- our own reproducible scenario data;
- read tools with short output;
- runbook retrieval that can refuse;
- numbers computed by pure functions.

Nothing here calls the LLM. This spec also holds the criteria that apply to the whole repository (network-free tests, dependency rule, pre-commit and CI), since it is the foundation for all the others.

## Scope

- `src/config.ts`: Zod-validated config that fails early without echoing values. `src/infra/redact.ts` and a JSON logger on stderr. `tests/setup/no-network.ts` blocks `fetch` in tests.
- `src/contracts/*`: Zod 4 schemas and types. `src/domain/canonical-json.ts` and `src/domain/errors.ts`.
- `SqliteIncidentStore` on top of `node:sqlite`:
  - prepared statements and manual transactions;
  - optimistic blackboard versioning;
  - `CHECK` constraints generated from the Zod enums;
  - insert-only audit, with triggers and a hash chain, ordered by `seq INTEGER PRIMARY KEY AUTOINCREMENT` (schema version 2; version 1 is migrated when the database is opened);
  - sequential ids from a counter in the database.
- Simulated and system clocks; deterministic series from a seeded PRNG; the `deploy-5xx-rollback` and `cost-anomaly` scenarios with our own data.
- 4 read tools (tier 1): `query_metrics`, `query_logs`, `list_deploys` and `audit_cloud_inventory`, with Zod parameters and a summary of up to 600 characters.
- FinOps inventory audit; BM25 per runbook section with restricted frontmatter and a normalized threshold; canary (`analyzeCanary`); incident metrics; numeric guard and post-mortem template.
- CLI `scenarios` and `tool`.
- Repository: `check:secrets`, `.githooks/pre-commit` and CI.

## Non-goals

- Real infrastructure (Kubernetes, Prometheus, AWS, Terraform): the world is simulated with deterministic data.
- Embeddings or a vector database: retrieval is lexical (BM25).
- ORM, generic YAML parser, `dotenv` or `tsx`.
- Job scheduler or external queue.
- `memory-leak-saturation` and CVE scenarios (v2 backlog).

## Acceptance criteria (EARS)

- **AC-21** The system shall prevent `UPDATE` and `DELETE` on the audit table through a database trigger, and each row shall store the hash of the previous one, computed over the canonical JSON from section 6.8.
- **AC-22** The system shall compute MTTD, MTTR, time awaiting approval, monthly savings and the illustrative ranges of minutes saved and ROI with pure functions, without calling the LLM, labeling each value as `measured`, `assumption` or `derived`.
- **AC-25** When no runbook section reaches the minimum normalized score, the retriever shall record a refusal (empty `runbookMatches`) instead of returning the least bad one.
- **AC-27** While `npm test` is running, every `fetch` call, in the test process and in child processes, shall fail with `NetworkDisabledInTests`.
- **AC-40** The system shall keep `src/contracts` and `src/domain` free of `node:*` imports and outer-layer imports, the SQL `CHECK` enums equal to the Zod enums, and `docs/autonomy-matrix.md` equal to the one generated from the catalog.
- **AC-41** The pre-commit hook shall run typecheck, unit tests and the secret scan and block the commit on failure; CI shall run typecheck (backend and web), backend tests, web tests, the web build, `check:tokens` and `check:secrets` with no secret configured.

Criteria from other milestones that use pieces from here:

- the numeric guard on the narrative (AC-23) is in `003-supervisor-team`;
- the end-to-end monthly savings of the cost scenario (AC-24) is in `004-remediation-gate`.

## How to verify

| Criterion | Tests |
|---|---|
| AC-21 | `tests/unit/store-audit.unit.test.ts`, `tests/unit/canonical-json.unit.test.ts` |
| AC-22 | `tests/unit/metrics.unit.test.ts` |
| AC-25 | `tests/unit/bm25.unit.test.ts` ("refuses below the threshold instead of returning the least bad") |
| AC-27 | `tests/unit/no-network.unit.test.ts` ("fetch is disabled during tests" and "child processes started by the test helpers also have fetch disabled (AC-27)"); the CLI (`runCli`) and the test MCP start children with `CHILD_NODE_ARGS` from `tests/helpers/spawn.ts` |
| AC-40 | `tests/unit/contracts.unit.test.ts`, `tests/unit/store-audit.unit.test.ts`, `tests/unit/docs-matrix.unit.test.ts` |
| AC-41 | `tests/unit/check-secrets.unit.test.ts`; `sh .githooks/pre-commit`; `.github/workflows/ci.yml` |

Demonstrable milestone: `npm run cli -- tool audit_cloud_inventory --scenario cost-anomaly --args '{"account":"data-platform"}'` shows US$ 339.59 in potential savings.

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "2.1 v1 boundary";
- "4.2 Components and single responsibility";
- "5.6 Configuration";
- "5.7 Metric formulas";
- "6.6 Secrets and redaction";
- "6.8 Audit trail";
- "7.3 Demo scenarios";
- "8.3 Acceptance criteria in EARS".

Section numbers cited in the criteria (such as "section 6.8") point to that document. What is needed from those sections is copied above. The formulas are also in `src/domain/metrics/incident-metrics.ts`, and the hash chain in `src/infra/db/incident-store.ts`.
