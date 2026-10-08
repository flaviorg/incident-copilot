# Lesson-to-code map

This project takes practices from the Software Engineering with Applied AI course (UNIPDS) and carries them into a different domain, with its own data. The table below cites each lesson **only by ID and topic**, the project file where the practice appears, and what the code proves. No excerpt of transcripts, slides, or authored material was copied. The scenarios, service names, log messages, inventory, and prices belong to the project: the lessons inspire the mechanism, not the numbers.

Each row's topic is the lesson's subject, summarized in my own words. When several lessons form a series on the same project, the topic names the series, and the "Practice proven" column says which part of it the project uses.

## Module 01: fundamentals

| Lesson | Topic | Project file | Practice proven |
|---|---|---|---|
| 198027 | Course introduction: the criterion of replicating in another domain | `fixtures/scenarios/`, `README.md` ("What I changed from the course") | Lesson mechanisms over the project's own data, with the list of what changed |
| 198069 | Prompt engineering: block-structured prompts and schema validation | `src/prompts/v1/*.ts` | Prompt with role, rules, and format, with output validated by schema |
| 198071 | AI tools for developers: roles, least privilege, and SDD | `src/mcp/tools/propose-remediation.ts` | No MCP tool approves or executes; approval only over HTTP with a token |
| 198081 | RAG, embeddings, and semantic search: flow and per-environment config | `src/infra/runbooks/runbook-repository.ts`, `src/config.ts` | Section-level search over `runbooks/`; model and provider switched by environment variable |
| 198082 | RAG, embeddings, and semantic search: minimum score, refusal, and versioned prompts | `src/domain/retrieval/bm25.ts`, `src/prompts/v1/` | Normalized score with a refusal threshold; prompts as versioned config (`<id>.v1`) |

## Module 02: APIs, LangGraph, and prompts

| Lesson | Topic | Project file | Practice proven |
|---|---|---|---|
| 200953 | AI-as-a-service market: model gateway with Fastify and OpenRouter | `src/llm/openrouter-provider.ts`, `src/http/server.ts` | `ChatOpenAI` with configurable `baseURL`; Fastify as the HTTP server |
| 200954 | AI-as-a-service market: fail-fast config, pinned versions, and tests with `app.inject` | `src/config.ts`, `.env.example`, `tests/e2e/http.e2e.test.ts` | Zod-validated config that fails without echoing values; HTTP tests without opening a port |
| 200955 | LangChain.js series (200955 to 200959): LangGraph command pipeline | `src/graph/graph.ts` | Graph with Zod 4 state, no template generator |
| 200956 | LangChain.js series: LangGraph command pipeline | `src/graph/state.ts` | Zod blackboard as the graph's single state |
| 200957 | LangChain.js series: LangGraph command pipeline | `src/graph/routing.ts` | `addConditionalEdges` with pure routing functions and an explicit `pathMap` |
| 200958 | LangChain.js series: LangGraph command pipeline | `src/graph/nodes/escalation-node.ts` | Every failure route ends in escalation, decided by code |
| 200959 | LangChain.js series: LangGraph command pipeline; reading on human-in-the-loop | `src/app/incident-service.ts` | Pause for a human decision with a persisted blackboard and explicit resume |
| 200960 | Prompt chaining and JSON prompts: steps with contracts | `src/contracts/*.ts` | Every graph step has an input and an output schema |
| 200961 | Prompt chaining and JSON prompts: native structured output | `src/llm/openrouter-provider.ts` | `withStructuredOutput` with JSON Schema, no manual `JSON.parse` |
| 200962 | Prompt chaining and JSON prompts: tests first and safe fallback | `tests/unit/*`, `src/graph/nodes/reporter-node.ts` | TDD across the project; a rejected narrative falls back to the template |
| 200963 | Prompt chaining and JSON prompts: "trust, but verify", factory DI, and partial state | `src/graph/nodes/*.ts` | `safeParse` in business nodes; each node gets only what it uses; action nodes have no LLM |
| 200968 | Memory and context compaction: test structure, not free text | `tests/e2e/scenarios.e2e.test.ts` | Assertions on enums, state, and numbers, never on the narrative |
| 200969 | Prompt injection, hijacking, and guardrails series (200969 to 200972) | `tests/fixtures/llm/injected-logs.json` | A hostile log with an embedded instruction reaches the analyst's prompt |
| 200970 | Prompt injection, hijacking, and guardrails series | `src/domain/autonomy/catalog.ts` | Closed catalog that denies by default |
| 200971 | Prompt injection, hijacking, and guardrails series | `src/domain/autonomy/catalog.ts` | Tier computed only by code, with no tier field in the model's output |
| 200972 | Prompt injection, hijacking, and guardrails series: guardrail tests | `tests/e2e/injection.e2e.test.ts` | `delete_backups` proposed after the injection ends as `blocked_forbidden`, with audit |
| 200978 | Advanced RAG (Text-to-Cypher): failure before success, recursion limit, lack of LLM-free tests | `src/app/incident-service.ts`, `src/llm/fake-provider.ts` | `recursionLimit` 25 with state preserved; the whole suite runs on a scripted fake |
| 200980 | Multimodal models and monitoring with Langfuse: traces, cost, and evaluation | `src/llm/recording-provider.ts`, `src/app/stats-service.ts` | Every call becomes a row in `llm_calls` with tokens, cost, and error; `/stats` aggregates |

## Module 03: MCP

| Lesson | Topic | Project file | Practice proven |
|---|---|---|---|
| 203474 | Building a custom tool in LangChain | `src/tools/registry.ts`, `src/mcp/tools/*.ts` | Descriptions that say when to use the tool; Zod parameters |
| 203477 | Understanding agents and instructions | `AGENTS.md`, `specs/constitution.md` | Factual instructions under 100 lines; a new dependency requires justification |
| 203479 | MCP from scratch: automated tests via an MCP client and inspection | `tests/helpers/mcp-client.ts`, `tests/e2e/mcp.e2e.test.ts` | `Client` and `StdioClientTransport` in tests; stdout carries only JSON-RPC |
| 203482 | Starter template, architecture, and code organization of an MCP server | `src/mcp/create-mcp-server.ts` | Thin server over the application services |
| 203483 | How companies use MCP to connect AI to legacy systems | `src/mcp/server.ts` | Same store and same schemas as the API |
| 203484 | Listing and creation tools | `src/mcp/tools/list-incidents.ts` | Filter and `LIMIT` in SQL, not in memory |
| 203485 | Update and delete tools, and use in VS Code | `src/mcp/tools/propose-remediation.ts` | Each test creates its own data; errors without internal details |

## Module 04: agents

| Lesson | Topic | Project file | Practice proven |
|---|---|---|---|
| 221503 | Inside the coding agent (GitHub Copilot) | `AGENTS.md` | Repository instructions for coding agents |
| 221504 | Context engineering and the permissions contract | `AGENTS.md` | Explicit rules for what an agent may and may not do in the repository |
| 221505 | Spec-driven development from scratch, part 1 | `specs/00N-*/spec.md` | EARS acceptance criteria per milestone |
| 221506 | Spec-driven development from scratch, part 2 | `specs/constitution.md`, `.githooks/pre-commit` | Non-negotiable principles; hook with typecheck, unit tests, and secret scanning |
| 221507 | Guardrails, reviewer, and delegation | `scripts/check-secrets.ts` | Deterministic guardrail that validates the result |
| 221508 | Three reasoning patterns | `src/graph/nodes/telemetry-node.ts`, `src/graph/nodes/auditor-node.ts` | ReAct in the analyst and Reflection in the auditor |
| 221509 | Setting up Spec Kit | `specs/` | Numbered specs per feature, with a constitution |
| 221510 | Initial project structure with Spec Kit | `src/app/container.ts`, `fixtures/scenarios/` | Single composition for API, MCP, CLI, and tests; deterministic synthetic scenarios instead of a mocked store |
| 221511 | Defining the ReAct pattern for the agent | `src/graph/nodes/telemetry-node.ts` | Thought, action, and observation loop capped at 12, without hitting the recursion limit |
| 221512 | Defining the Plan-and-Execute pattern for the agent | `src/graph/nodes/planner-node.ts`, `src/app/trace-sink.ts` | Structured plan with up to 8 steps; persisted typed trace |
| 221513 | Critiques and benchmarking with the Reflection pattern | `src/graph/nodes/auditor-node.ts`, `src/domain/audit/auditor-rules.ts` | Zod verdict with up to 2 revisions and a rule floor in code |
| 221514 | An API that is also an agent | `src/http/routes/incidents.ts` | Codes 400, 422, 503, and 504; 180 s timeout per run |
| 221515 | Specifying the database integration | `src/infra/db/sqlite.ts`, `src/infra/db/incident-store.ts` | `node:sqlite`, prepared statements, `:memory:` in tests |
| 221516 | Creating and querying incidents in the database | `src/infra/db/schema.ts` | `CHECK` constraints generated from Zod enums, no drift between SQL and contract |
| 221517 | Validating external provider availability | `src/tools/registry.ts` | A failing tool becomes an `observation` with `ok: false` and the loop continues |
| 221518 | Exposing the agent via MCP | `src/mcp/server.ts`, `.vscode/mcp.json`, `.cursor/mcp.json` | Second port over the same store; logs on stderr |
| 221522 | Context as a budget: measurement and summarization | `src/llm/usage.ts` | Token estimate (about 4 characters per token) in the fake |
| 221524 | LangGraph and model fallback | `src/llm/resilience.ts` | 2 attempts on the primary, fallback, and 503 |
| 221525 | Building observability strategies | `src/http/request-id.ts`, `src/app/stats-service.ts`, `src/domain/autonomy/catalog.ts` | `X-Request-Id`, JSON logger, `/stats` with P50 and P95 in SQL, tiers 1 to 4 |
| 221526 | Implementing the War Room | `web/src/` | War Room in React and Vite |
| 221527 | Publishing the War Room on GitHub Pages | `.github/workflows/pages.yml`, `web/vite.config.ts` | Vite `base` and manually triggered deploy only; demo mode instead of a tunnel |
| 221528 | Implementing multi-agent systems | `src/graph/nodes/supervisor-node.ts` | Supervisor that only orchestrates, `brief`, handoffs in the trace, cap of 8 |

## Module 05: UX and UI with AI

| Lesson | Topic | Project file | Practice proven |
|---|---|---|---|
| 210738 | Pix App: design tokens generated from the brand brief | `web/src/styles/tokens.css`, `scripts/check-tokens.ts` | Colors only in tokens; a scan that fails on literal colors outside them |
| 210739 | Pix App: accessible modal component | `web/src/components/ApprovalDialog.tsx` | `role="dialog"`, `aria-modal`, focus trap, Escape closes |
| 210742 | Pix App: contrast and narrow-screen layout fixes | `web/src/test/tokens-contrast.test.ts`, `web/src/styles/components.css` | 4.5:1 contrast proven by test; single column on narrow screens |
| 210744 | CFP Platform: contract library shared between front end and back end | `src/contracts/demo-recording.ts` | The War Room imports the backend schemas |
| 210745 | CFP Platform: OpenSpec with non-goals | `specs/00N-*/spec.md` | A `## Non-goals` section in every spec |
| 210748 | CFP Platform: async agent delivering via PR, with no writes to the main branch | `AGENTS.md` | Nothing is published without human validation |
| 210764 | BragBot: mock-first interface | `web/src/data/demo-source.ts` | War Room that runs on recordings alone, without a backend |
| 210765 | BragBot: flow with Zod and runtime validation | `web/src/data/demo-source.ts` | Recording validated by `DemoRecordingSchema` in the browser; an invalid one becomes an explicit error |

## Module 06: AIOps and agentic engineering

| Lesson | Topic | Project file | Practice proven |
|---|---|---|---|
| 213409 | Agents for Kubernetes (K8s AI-Ops): canary | `src/domain/canary/canary-analyzer.ts` | 5% 5xx threshold in code |
| 213410 | Agents for Kubernetes (K8s AI-Ops): the challenge of making the canary fail | `tests/e2e/gate.e2e.test.ts` | Scenario with bad series fails the canary and reverts the actions |
| 213411 | Troubleshooting and diagnosis with ReAct series (213411 to 213413) | `src/tools/query-metrics.ts` | Metrics from deterministic synthetic series |
| 213412 | Troubleshooting and diagnosis with ReAct series | `src/tools/query-logs.ts`, `src/tools/list-deploys.ts` | Logs grouped by message and version; suspect deploy with its previous version |
| 213413 | Troubleshooting and diagnosis with ReAct series | `src/contracts/diagnosis.ts` | Diagnosis with an enum category, confidence, and cited evidence |
| 213417 | ChatOps and governance with human-in-the-loop series (213417 to 213419) | `src/app/approval-service.ts` | Human decision over HTTP, with a token |
| 213418 | ChatOps and governance series: the approval secret | `src/infra/redact.ts`, `tests/e2e/secrets.e2e.test.ts` | Token kept out of code and redacted on all 7 output surfaces |
| 213419 | ChatOps and governance series | `src/domain/approval/parse-decision.ts` | Closed list of terms; anything else is ambiguous and gets 422 |
| 213428 | FinOps and cost optimization (inspiration) | `src/domain/finops/inventory-audit.ts` | Unattached volume, unassociated IP, and oversized instance |
| 213429 | FinOps and cost optimization (inspiration) | `data/cloud-prices.json`, `tests/unit/inventory-audit.unit.test.ts` | Monthly savings computed from the project's own inventory and prices |
| 213430 | Runbook RAG and automatic post-mortem | `runbooks/`, `src/infra/runbooks/runbook-repository.ts` | Section-level BM25, with refusal below the threshold |
| 213431 | Runbook RAG and automatic post-mortem | `src/domain/report/postmortem-template.ts` | Post-mortem with summary, cause, action, and prevention; deterministic template |
| 213437 | Safe auto-remediation with guardrails | `src/infra/simulated-infra.ts`, `src/graph/nodes/gate-node.ts` | Dry run before any queue; circuit breaker and rate limit |
| 213438 | Safe auto-remediation with guardrails | `src/domain/approval/approval-machine.ts` | State machine in code; rejection cancels dependents |
| 213439 | Capstone project (Nexus Manager): hierarchical orchestration | `src/graph/graph.ts` | Supervisor coordinating specialists |
| 213440 | Capstone project (Nexus Manager): delegation and reporting | `src/graph/nodes/reporter-node.ts` | Reporter that only writes from computed facts |
| 213441 | Capstone project (Nexus Manager): value and ROI report | `src/domain/metrics/incident-metrics.ts`, `src/domain/report/numeric-guard.ts` | MTTR from data; ROI only as an illustrative range; numeric guard |
| 213487 | What to do with AI in DevOps series (213487 to 213489) | `docs/architecture.md` | Architecture documented for whoever evaluates the project |
| 213488 | What to do with AI in DevOps series | `fixtures/scenarios/cost-anomaly/` | FinOps scenario with Reflection and a forbidden step |
| 213489 | What to do with AI in DevOps series: portfolio with real incidents | `docs/incidents/` | Post-mortems of real failures during the build |
| 213495 | Podcast on supply chain: deterministic automation for destructive actions | `src/domain/autonomy/catalog.ts` | The rule decides the tier of a destructive action, not the model |

## Module 06 patterns in TypeScript

Module 06 uses Python and CrewAI. This project reimplements the patterns in TypeScript with LangGraph:

| In the course (Python and CrewAI) | In the project (TypeScript and LangGraph) |
|---|---|
| `Agent(role, goal, backstory)` | Node factory (`createXNode(deps)`) and versioned prompt |
| Sequential `Crew` | Fixed `StateGraph` edges (planner to auditor) |
| `manager_agent` with delegation | Supervisor node with `SupervisorDecisionSchema` and a precondition guard in code |
| Tools simulated with conditionals | Tools with Zod parameters over synthetic series generated from a deterministic spec |
| Runbook looked up by service parameter | BM25 over runbook sections with frontmatter, normalized threshold, and refusal |
| Approval password in code | Token in `APPROVAL_TOKEN`, constant-time comparison, redaction on every output |
| "Yes/no" approval interpreted by the agent | State machine in code with a closed list of terms |
| Canary that never failed | Pure function with a bad-metrics scenario and automatic rollback |
| ROI written by the manager | Pure metric functions, ROI as an illustrative range, and a numeric guard on the narrative |
| Log with a run hash | `runId`, `requestId`, persisted trace, and hash-chained audit log |
