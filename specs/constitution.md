# incident-copilot constitution

Non-negotiable principles. Every spec in `specs/NNN-*/spec.md`, every plan and every code change follows this file. Changing a principle requires recording the reason here, in the same commit.

## 1. The thesis

**The model proposes; code and humans decide.**

- The LLM picks the next specialist, investigates, builds the plan, asks for review and writes.
- Deterministic code:
  - classifies risk;
  - decides what runs on its own;
  - enforces the plan's quality floor;
  - guards the approval;
  - computes the numbers;
  - writes the audit trail.
- No safety guarantee depends on prompt text.

## 2. Dependency rule

- `src/contracts` and `src/domain` do not import `node:*` nor `infra`, `llm`, `graph`, `app`, `http`, `mcp` or `cli`. A test checks this.
- `graph` receives dependencies through factories; from outer layers it imports types and only the trace formatting utilities. Each node receives only what it uses. Action nodes get no LLM.
- The ports (`http`, `mcp`, `cli`) talk to `app`. SQL enums are generated from the Zod enums.

## 3. Tests

- TDD: the test fails first, then the minimal implementation, then green.
- `npm test` never uses the network or a real key. `fetch` is blocked in the test process and its children.
- No test compares free LLM text for equality; tests assert structure, enums, state and numbers.
- The fake provider is scripted and strict: a call without a turn breaks the test. Fixtures change together with prompts.

## 4. Secrets

- `APPROVAL_TOKEN` and `OPENROUTER_API_KEY` are never echoed: they do not appear in HTTP responses, MCP output, trace, audit, logs, reports or recordings.
- All text leaving the process goes through `redactSecrets`.
- `check:secrets` runs in the pre-commit hook and in CI.

## 5. Tier 4 by construction

- The tier comes from the catalog and from rules that only raise it. LLM output has no tier field.
- A forbidden or unknown action has no executor (the type does not exist), no dry run and no queue, and is audited.
- The audit trail is insert-only, with database triggers and a hash chain.

## 6. Nothing published without human validation

- No `git push`, `npm publish`, remote repository or deploy without the project owner's explicit approval.
- The Pages workflow only runs on manual dispatch. `npm run setup:hooks` only after the folder has its own Git repository.

## 7. Languages

- Code, types, columns, fields and test names in English (`tier`, `TierSchema`, `TierBadge`).
- Human-facing text in English (en-US number formats): CLI, API, MCP, War Room, error messages, prompts, README, docs and specs. The user-facing term is "tier".

## 8. Dependencies

- Exact versions in `package.json`. Every new dependency requires a written justification in the spec or plan: what it solves and why what already exists is not enough.
- Before using a library for the first time, its real API is checked in the `.d.ts` files and recorded in `docs/api-notes.md`.

## 9. Course material

- Lessons cited only by ID and topic.
- No transcript excerpt, slide or authored material in the repository. Data, names, messages and prices are our own.
