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

The War Room needs `npm run web:install` once, before `typecheck:web`, `web:test` and `web:build`.

## Folder map

| Folder | Contents |
|---|---|
| `src/contracts` | Zod schemas and types shared with the War Room. No logic, no I/O |
| `src/domain` | Pure rules: tiers, approval, auditor, guards, canary, metrics, BM25 |
| `src/infra` | SQLite, scenarios, runbooks, simulated world, clock, ids, logger, redaction |
| `src/llm`, `src/prompts/v1` | Providers (fake and OpenRouter), resilience, versioned prompts |
| `src/graph` | LangGraph graph, routes and nodes (one per file, built by factories) |
| `src/app` | Application services and `container.ts` |
| `src/http`, `src/mcp`, `src/cli` | Ports: Fastify API, stdio MCP server, CLI |
| `fixtures/` | Scenarios with their own data and the fake's scripts |
| `tests/` | `unit`, `e2e`, `golden`, `fixtures/llm` (test-only scripts), `helpers`, `live` |
| `web/` | War Room (nested package, separate install) |
| `docs/`, `specs/` | Technical documentation, post-mortems and SDD specs |

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
