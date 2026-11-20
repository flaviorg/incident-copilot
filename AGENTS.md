# AGENTS.md

Instructions for coding agents in this repository. Full principles are in `specs/constitution.md`; per-milestone requirements are in `specs/NNN-*/spec.md`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Backend suite (unit and end-to-end), no network |
| `npm run test:unit` | Unit tests only (what the pre-commit hook runs) |
| `npm run typecheck` | Backend `tsc --noEmit`; use `npm run typecheck:web` for the War Room |
| `npm run verify` | Everything CI runs: typecheck, tests, web tests and build, `check:tokens`, `check:secrets` |
| `npm run demo` | Offline `deploy-5xx-rollback` scenario with the fake (`-- --scenario cost-anomaly`, `-- --reject`) |
| `npm run regen` | Regenerates the metrics goldens and `docs/autonomy-matrix.md` |
| `npm run fixtures:rehash` | Updates the prompt hashes in the fake's fixtures |
| `npm run check:secrets` | Looks for keys and tokens in the tree |
| `npm run cli -- config check [--file <path>]` | Validates `copilot.yaml` (default `COPILOT_CONFIG`, then `./copilot.yaml`); exit 0 when valid, 1 otherwise; never prints a value |
| `npm start` | API; with ingest connectors in `copilot.yaml` it needs a real LLM provider (the fake is refused) |

The War Room needs `npm run web:install` once, before `typecheck:web`, `web:test` and `web:build`.

## Folder map

| Folder | Contents |
|---|---|
| `src/contracts` | Zod schemas and types shared with the War Room. No logic, no I/O |
| `src/domain` | Pure rules: tiers, approval, auditor, guards, canary, metrics, BM25 |
| `src/infra` | SQLite, scenarios, runbooks, simulated world, clock, ids, logger, redaction |
| `src/infra/copilot-config` | `copilot.yaml` loader: YAML or JSON, `${VAR}` interpolation, zod schema built from the registered definitions, `assertLiveSafe` |
| `src/connectors` | Connector port (`types.ts`), registry, shared kit (`shared/`: HTTP over injected `fetch`, webhook auth, config helpers, errors) and one folder per provider; `index.ts` is the only list of types |
| `src/notifiers` | Notifier port (`types.ts`), `slack/`, `outbound-webhook/`; `index.ts` is the only list of types |
| `src/tools`, `src/tools/live` | The analyst's tier 1 tools: scenario tools, and the live tools that call the connectors' query capabilities |
| `src/llm`, `src/prompts/v1` | Providers (fake and OpenRouter), resilience, versioned prompts |
| `src/graph` | LangGraph graph, routes and nodes (one per file, built by factories) |
| `src/app` | Application services and `container.ts` |
| `src/http`, `src/mcp`, `src/cli` | Ports: Fastify API, stdio MCP server, CLI |
| `fixtures/` | Scenarios with their own data and the fake's scripts |
| `tests/` | `unit`, `e2e`, `golden`, `fixtures/llm` (test-only scripts), `fixtures/connectors/<type>`, `fixtures/notifiers`, `helpers` (fake fetch, conformance kits), `live` |
| `web/` | War Room (nested package, separate install) |
| `docs/`, `specs/` | Technical documentation, post-mortems and SDD specs; one setup guide per connector or notifier type in `docs/connectors/<type>.md` |

## Rules

- **TDD.** Write the test, watch it fail, implement the minimum, watch it pass. Tests live in `tests/unit/*.unit.test.ts` or `tests/e2e/*.e2e.test.ts`, using `node:test` and `node:assert/strict`.
- **No network in tests.** `fetch` is blocked by `tests/setup/no-network.ts`. Child processes in tests start with `--import ./tests/setup/no-network.ts`. Never use a real key.
- **Zod 4:** `import * as z from "zod"`. Never `zod/v3`.
- **Pure domain.** `src/contracts` and `src/domain` do not import `node:*` or outer layers (a test enforces it).
- **Native Node 24 TypeScript.** Relative imports with `.ts`, `import type` for types, no `enum` or `namespace`.
- **The tier comes from the catalog.** Never read a tier, approval or execution decision from LLM output. Context rules only raise the tier.
- **Never echo a secret.** All text leaving the process goes through `redactSecrets`. Tests that need a key-shaped value build it at run time (`"sk-or-v1-" + "a".repeat(40)`).
- **Fixtures change together with prompts.** Changed a `system` in `src/prompts/v1`? Run `npm run fixtures:rehash`. Changed input or flow? Adjust the turns. Details in `docs/fake-provider.md`.
- **Goldens change only on purpose.** Run `npm run regen` and review the diff before accepting it.
- **Do not test free LLM text for equality.** Assert structure, enums, state and numbers.
- **Language.** Identifiers and all human-facing text (CLI, API, MCP, post-mortems, War Room, prompts, fake scripts, docs and specs) are in English, with en-US number formats.
- **A new dependency needs a justification** and an exact version.
- **Publish nothing.** No `git push`, `npm publish`, remote repository or Pages trigger without the owner's approval. Do not run `npm run setup:hooks` while the folder is inside another Git repository.
- **A real failure becomes a note.** Record it in `docs/incidents/notes.md`, with date, symptom and cause. Never invent one.

## How to add an action to the catalog

1. **Test first.** In `tests/unit/autonomy.unit.test.ts`, assert the tier and the valid and invalid parameters. In `tests/unit/simulated-infra.unit.test.ts`, assert the dry run, execution and rollback.
2. **Catalog.** Add the entry to `EXECUTABLE_ACTIONS` (`src/domain/autonomy/catalog.ts`): tier 2 or 3, `mitigates`, `reversible`, `durationSec`, `targetKind`, a strict `paramsSchema`, `targetPattern`, `paramsText` and `description`. A forbidden action goes in `FORBIDDEN_ACTIONS`, never in `EXECUTABLE_ACTIONS`.
3. **Executor.** Implement the executor in `EXECUTORS` (`src/infra/simulated-infra.ts`). The registry is `Record<ExecutableActionType, Executor>`, so the typecheck fails until it exists.
4. **Auditor rule**, if the action needs evidence: `src/domain/audit/auditor-rules.ts`, with a test.
5. **Regenerate.** Run `npm run regen`, which updates `docs/autonomy-matrix.md` and the goldens, and review the diff. The catalog enters the planner prompt as input, not in the `system` text, so the fixture hash does not change.
6. **Verify.** Run `npm run typecheck && npm test`.

## How to add a connector

Design: `docs/connectors-architecture.md`. A live incident is shadow mode only: a connector receives alerts and reads data, it never writes to the provider.

1. **Test first.** Create `tests/unit/connectors-<type>.unit.test.ts` and run `describeConnectorConformance(definition, { env, entry, secrets, withCredentials, withWrongCredentials, payloads, query? })` from `tests/helpers/connector-conformance.ts`, plus mapping, verify and config cases. Put payload fixtures in `tests/fixtures/connectors/<type>/`, built from the provider's documentation, with a `README.md` that states the source of each one and that they are not captures. Query tests use `createFakeFetch` (`tests/helpers/fake-fetch.ts`); never the network.
2. **Folder.** `src/connectors/<type>/` with `index.ts` (`defineConnector({ type, displayName, capabilities, configSchema, create })`), `config.ts`, `ingest.ts` and `query.ts` as needed. Config schemas are `z.strictObject`; `create` does no I/O.
3. **Verify** runs on `req.rawBody`, before any parsing, and never throws. Reuse `verifyWebhookAuth` (`src/connectors/shared/auth.ts`) or `hmacDigest`; every comparison is constant-time (`timingSafeEqual` on equal-length buffers, `constantTimeEqualsText`). Ingest without authentication is not allowed.
4. **Parse is pure and never throws.** It returns `alerts`, `ignored` or `invalid` (issues never echo values). Text goes through `asString`/`sanitizeText`; `externalId` is stable across retries of one provider event, `fingerprint` across events of one problem.
5. **Query goes through `deps.http` only** (timeout, response cap, no redirects) and throws only `ConnectorError` with a kind: `auth`, `rate_limited`, `timeout`, `unavailable`, `bad_response`, `unsafe_input`. Return the normalized records of `src/contracts/live-telemetry.ts`.
6. **No LLM-written queries.** Query strings come from code or config templates; substituted values pass a strict allowlist, or the method throws `unsafe_input` before any request.
7. **Secrets only via `h.secret()`** (a whole `${VAR}` reference, joined to the redaction list); URLs via `h.url()`; other strings via `h.text()`.
8. **Register** the definition in `CONNECTOR_DEFINITIONS` (`src/connectors/index.ts`). `tests/unit/connectors-registry.unit.test.ts` then requires the guide and a unique type.
9. **Guide.** `docs/connectors/<type>.md`: step-by-step setup, the `copilot.yaml` entry, the mapping, then a "Facts and sources" section and an "Unverified" section for every provider fact the documentation did not confirm. Add an entry to `copilot.example.yaml` and the variable names to `.env.example`.
10. **Verify.** Run `npm run typecheck && npm test`.

## How to add a notifier

1. **Test first.** `tests/unit/notifiers-<type>.unit.test.ts` with `describeNotifierConformance(definition, { env, entry, secrets, okRoutes, failureRoutes })` (`tests/helpers/notifier-conformance.ts`) and a hand-written golden body in `tests/fixtures/notifiers/`, built from `sampleNotificationMessage()`.
2. **Folder.** `src/notifiers/<type>/` with `index.ts` (`defineNotifier({ type, configSchema, create })`) and a pure `render.ts`.
3. **Send never throws.** It returns `{ ok: true }` or `{ ok: false, retryable, retryAfterSec, reason }` with a fixed reason; it goes through `deps.http` only and never puts a URL, token or body in the outcome. A notifier never changes incident state.
4. **Escape** the target's markup (Slack: `&`, `<`, `>`); the message is already redacted by `NotificationService`.
5. **Secrets only via `h.secret()`**, including a URL that is itself a credential.
6. **Register** it in `NOTIFIER_DEFINITIONS` (`src/notifiers/index.ts`), write `docs/connectors/<type>.md` with "Facts and sources" and "Unverified" (notifier and connector types share that folder, so names must not collide), and add it to `copilot.example.yaml`.
7. **Verify.** Run `npm run typecheck && npm test`.
