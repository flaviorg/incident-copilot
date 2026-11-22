# 009: Code fixer

Milestone M9, release 0.5.0. Status: planned.

## Context

Up to 0.4.0 a live incident ends `advised`: the copilot diagnoses, recommends and executes nothing. Many real incidents behind a `bad_deploy` diagnosis are small code bugs: a `TypeError` on an `undefined` field, an off-by-one `RangeError`. The team then fixes by hand what the stack trace already pointed at.

This milestone adds a **code fixer**. When a live incident's diagnosis and the error provider's own data point at a small bug in a repository the operator allowlisted, the copilot writes a regression test that reproduces the error and must fail, writes the smallest patch that makes it pass without breaking the suite, reviews the diff, and attaches patch and evidence to the report. In `draft_pr` mode it also asks a human to approve opening a **draft** pull request on GitHub. It never merges.

The thesis does not change: **the model proposes; code and humans decide.** The model writes one test file, one small source edit and one veto-only review. Code decides whether the incident is eligible, which repository, file, line and commit, whether the test fails for the right reason, whether the suite still passes, whether the diff is small, the tier, and whether anything reaches GitHub. A human decides whether the pull request is opened.

Most incidents must fail the filter. Giving up is the normal outcome and always leaves a typed reason, an audit row and, when something was learned, a suggestion in the report.

Prior art by the same owner (`test-medic`, `pr-review-swarm`) contributed ideas only: a deterministic guard before any model-written change runs, human approval for the write, injection markers over model output. No code is ported.

## Scope

- **A post-incident job**, outside the incident graph: `CodeFixQueue` and `CodeFixService` (`src/app/`), with a small LangGraph `StateGraph` of its own (`src/graph/code-fix/`).
- **Sentry only** as the error source: two new optional query members, `errorEvent` (exception and stack frames of the latest event of an issue) and `releaseCommit` (release version to commit SHA). They are not LLM tools.
- **Node only** as the target stack: repositories whose suite runs with plain `node --test` and no install or build step (native TypeScript stripping covers TypeScript repositories).
- **Sandbox**: `ProcessSandboxRunner` on the Node permission model, with an allowlisted environment, a process-group timeout, and network isolation through Linux `unshare` or an explicit, stamped `best_effort` mode.
- **Workspace**: `GitCliWorkspace`, a shallow fetch of the allowlisted repository into a temporary directory with hooks, symlinks, submodules, LFS and the host's git config disabled.
- **GitHub code host** (`src/codehost/github/`): REST over the injected `fetch`, a reader (commit, branch, compare, pull lookup) and a writer that can only open a draft pull request.
- **Catalog action** `open_draft_pull_request`, tier 3, reserved for the code fixer.
- **Modes**: `codeFix.mode: shadow` (default; patch and evidence in the report, no GitHub write) and `draft_pr` (approval bound to the patch hash, then a draft pull request).
- **Surfaces**: `GET /incidents/:id/code-fix`, a "Code fix" section appended to the postmortem Markdown, code-fix approvals in the existing `GET /approvals` and `POST /approvals/:id/decision`, two opt-in notification kinds, `config check` validation.
- **Packaging**: `git` and `util-linux` in the runtime image, `copilot.example.yaml`, `.env.example`, `docs/code-fixer.md`, README, CHANGELOG 0.5.0.

## Decisions

1. **A separate job, not a graph node.** `IncidentService.handleAlertJob` already returns a follow-up closure that the alert queue runs after the run slot is freed and the final blackboard is persisted. On the `analysis_ready` path (never on `run_failed`) the closure calls `live.codeFix?.consider(incidentId)`, which never throws and never awaits the attempt. `CodeFixQueue` runs attempts with its own concurrency (`limits.maxConcurrent`, default 1, max 2), separate from `RunSlots`. The fixer reads the blackboard once with `loadBlackboard` and **never writes it**: it holds no `runs` row and no run slot, uses no recursion or team budget, and cannot race approvals or dedupe on the blackboard version. Incident status, scenario goldens and recordings are untouched.

2. **Its own small graph, one-shot persistence, no interrupt.** `buildCodeFixGraph(nodes, deps)` over `CodeFixStateSchema`, node factories, pure routes in `src/graph/code-fix/routing.ts`, one `addConditionalEdges` per origin with an explicit path map, `recursionLimit: 24`, no checkpointer. Node ids carry a `fix_` prefix so none equals a state key. The `code_fix_attempts` row is the single source of truth; the service writes it at stage boundaries with an optimistic `version`. On start, `CodeFixService.recover()` ends `running` attempts as `gave_up/interrupted` (an interrupted run is not resumed, as in spec 008) and re-enqueues `publishing` attempts, whose publish is idempotent (decision 15).

3. **Least privilege by construction.** The fixer graph receives `CodeHostReader`, `GitWorkspacePort`, `SandboxRunner` and the LLM, never a writer. Only `CodeFixPublisher` (`src/app/`, no LLM) holds a `CodeHostWriter`, and it runs only for an approved attempt. In shadow mode the container does not build a writer at all.

4. **Eligibility is deterministic and deny by default.** `evaluateEligibility()` (`src/domain/code-fix/eligibility.ts`, pure) returns `{ eligible: true }` or `{ eligible: false, reason }`. In order: incident status `advised` and no escalation; `origin.source === "sentry"` and `origin.fingerprint` matches `^issue:(\d{1,20})$` (set by the Sentry ingest code, not by the LLM); `diagnosis.category === "bad_deploy"` with confidence `medium` or `high`; `alert.service` maps to exactly one allowlisted repository; that repository's connector has `errorEvent`, `releaseCommit` and `deploys`; the sandbox self-test passed; the repository's daily cap is not reached; no attempt **holds the key** `(repo, errorGroupId)` (decision 16). A failure records a `skipped` row with the reason and audits `code_fix_skipped`, with no LLM call, no git and no code-host write. No new `RootCauseCategory` is added: `bad_deploy` plus the deterministic evidence below is the code-bug signal.

5. **Location comes from connector data only.** `fix_locate` calls `errorEvent`, `deploys` and `releaseCommit` through the registry and `safeParse`s every result.
   - Exception: the last value of the latest event's exception entry; its `type` must be in `fixableExceptionTypes` (default `TypeError`, `RangeError`, `ReferenceError`).
   - New in the failing release: the failing release is the event's `release`; the matching deploy is the newest one with that version and `at <= alert.startedAt + 5 min`; the issue's `firstSeen` must be `>= deploy.at - 5 min`. A null `firstSeen` or release fails closed (`not_new_in_release`), whatever the category.
   - Anchor frame (`src/domain/code-fix/frames.ts`, pure): the innermost `inApp` frame, after stripping the configured `pathPrefixes`, must be a repo-relative POSIX path with no `..`, no absolute or Windows path, no NUL, no `node_modules/`, `dist/`, `build/` or `.min.` segment, an extension in `.js .mjs .cjs .ts .mts .cts`, inside `sourceGlobs` and outside every denied path.
   - Commit: `lastCommit.id` when it is 40 hex and its repository equals the allowlisted `owner/name`; else the release version, or its part after the last `@`, when it is 40 hex; else `commit_unresolved`. The SHA is then confirmed by `CodeHostReader.commitExists`.
   - Errors here are `skipped`, not `gave_up`: nothing was cloned yet.

6. **The workspace is a hardened shallow fetch.** Attempt directory `mkdtemp(realpath(tmpdir())/ic-fix-)` with siblings `repo/` (work tree), `tmp/` (the child's `HOME` and `TMPDIR`), `kit/` (sandbox preload and reporter copies) and `git/` (askpass script). Nothing the runner writes lives in the work tree. Every git child runs through `execFile` (no shell) with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_CEILING_DIRECTORIES=<attempt>`, `HOME=<attempt>/tmp`, and `-c core.hooksPath=/dev/null -c core.symlinks=false -c core.fsmonitor=false -c credential.helper= -c protocol.allow=never -c protocol.https.allow=always -c submodule.recurse=false`. That covers fetch, checkout, show, ls-tree, add, diff and status. Steps:
   - `git init`, then `git fetch --depth 1 --no-tags origin <baseBranch> <sha>`, then `git checkout --detach <baseHead>`.
   - The token reaches git only through `GIT_ASKPASS`: a 0700 script in `git/` that prints `$IC_GIT_PASSWORD`, an env var set only on fetch children. The token is never in a URL, argv or `.git/config`.
   - The anchor file must exist at `<sha>` with the line in range, have mode `100644` at the base head (no symlink or submodule), and be byte-identical at `<sha>` and the base head (`git diff --quiet <sha> <baseHead> -- <path>`). Otherwise `file_changed_since_release`. Work starts from the base head, so the patch applies to what is merged today.
   - Conventions (read-only, regular files only through `lstat`, sanitized, clipped to 24,000 characters in total): `AGENTS.md`, `CONTRIBUTING.md`, `package.json` (`type` and `scripts.test` as data only), the two test files matching `testGlobs` that are nearest to the anchor by path, and the anchor window of ±60 lines.
   - Clone URLs come from the allowlist only, `https` only. `file://` is allowed only through the test-only constructor option `allowFileProtocol`, which config cannot set.
   - The directory is removed in a `finally` block of every attempt.

7. **Test runs use the Node permission model; network isolation uses the OS.** `ProcessSandboxRunner` (`src/infra/code-fix/process-sandbox.ts`) builds the whole argv itself. The operator only names test globs (`testFiles`), validated by `^[A-Za-z0-9_./*{},-]+$` with no leading `-` or `/` and no `..`:

   ```
   [unshare --user --map-root-user --net --]   # isolated mode only
   <process.execPath> --permission
     --allow-fs-read=<attempt>/repo,<attempt>/kit,<attempt>/tmp
     --allow-fs-write=<attempt>/tmp
     --disallow-code-generation-from-strings
     --import=<attempt>/kit/preload.ts
     --test --test-isolation=none
     --test-reporter=<attempt>/kit/reporter.ts --test-reporter-destination=stdout
     <files or globs>
   ```

   - No `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi` or `--allow-inspector`. The copilot's source, `copilot.yaml`, `.env` and database are outside every read grant. The kit files are self-contained (only `node:*` imports) and copied into `kit/` before the first run.
   - `spawn(argv[0], rest, { shell: false, cwd: <attempt>/repo, detached: true, stdio: ["ignore", "pipe", "pipe"] })`. The timeout (`limits.testTimeoutSec`) or abort sends `process.kill(-pid, "SIGKILL")` to the whole process group. stdout and stderr are capped at `limits.maxOutputBytes` (tail kept) and pass through `redactSecrets`.
   - The environment is built from an allowlist, never inherited: `PATH` (the directory of `process.execPath` plus `/usr/bin:/bin`), `HOME` and `TMPDIR` (`<attempt>/tmp`), `CI=1`, `NODE_ENV=test`, `LANG=C.UTF-8`, `TZ=UTC`, `NO_COLOR=1`. The GitHub token, `OPENROUTER_API_KEY`, `APPROVAL_TOKEN` and `API_TOKEN` are never in it.
   - The preload replaces `fetch`, blocks `node:net`, `tls`, `dgram`, `dns`, `http`, `https`, `http2` and `child_process` through `module.registerHooks` (import and require), and patches `process.getBuiltinModule`. This is best effort: Node 24.21 has no `--allow-net` (checked locally), so it is not the network control.
   - **Network:** `codeFix.sandbox.network: isolated | best_effort`, default `isolated`, which wraps argv in `unshare` (util-linux, Linux only). At start, when `codeFix` is enabled, a **self-test** runs a bundled probe through the full runner. It asserts that `child_process` is denied, a write outside `tmp/` is denied, a read of the copilot's config and database paths is denied, a planted env secret is absent, and TCP to 127.0.0.1 and to the GitHub API host fails. If any check fails in `isolated` mode, the fixer is disabled and every eligible incident is recorded `skipped/sandbox_unavailable`. `best_effort` must be chosen explicitly and is stamped on the attempt, the report and the pull request body.
   - **Results come from our reporter.** The NDJSON reporter writes prefixed lines to stdout: per test `{ name, file, status, errorName, message, frames }`, where `errorName`, `message` (clipped to 200) and `frames` (repo-relative `file:line`, at most 10) come from the failure's `cause`. The parent parses only prefixed lines and cross-checks them with the exit code: non-zero with no reported failure, zero with a failure, an empty report or zero tests all become `error`, never `passed`. In-process results can be forged by code that runs in the same process, so model-written code is statically banned from touching `process`, `console`, `globalThis` and dynamic imports (decision 10). Human approval stays the final control, as the docs say.
   - There is no dependency install in 0.5: `npm ci`, `npx` and lifecycle scripts are arbitrary code and network.

8. **Two authors, test first, and the patch author never sees the test.** Each model call has its own prompt, and code enforces the order:
   - `fix_baseline` runs the full suite before any LLM call. It must report `passed` with `total > 0`.
   - `fix_author_test` (`fix-test.v1`) proposes `{ test: { path, content }, rationale }`.
   - `fix_guard_test` runs `checkTestFile()` (decision 10).
   - `fix_repro` writes **only the test file** and runs only that file twice.
   - `fix_author_patch` (`fix-patch.v1`) receives the exception, the frames, the anchor window, the conventions and the observed failure facts (name, `errorName`, frames). It never receives the test content. It proposes `{ edits: [{ path, search, replace }] (1..2), rationale }`, and each `search` must occur exactly once (`edit_not_applicable`).
   - `fix_guard_patch` runs `checkPatch()` on the edits.
   - `fix_verify` applies the edits and re-checks the real diff.
   - A guard rejection, `repro_not_failing` or `repro_wrong_reason` sends the test author back with the violation sentences. A guard rejection, `edit_not_applicable` or `fix_not_passing` sends the patch author back. Each author has at most `limits.maxAuthorAttempts` calls (default 2, max 3). `repro_flaky`, `suite_regressed` and `test_count_dropped` are not retried.

9. **"Fails for the right reason" is a deterministic check.** `classifyReproduction(runs, exception, anchor)` (`src/domain/code-fix/repro.ts`, pure) returns `right_reason`, `wrong_reason` or `not_failing`. Both runs must fail the new test (and only the new test) with the same signature. The failure's `errorName` must equal the incident's exception type, or its message must contain the normalized prefix of the incident's message. `SyntaxError`, `ERR_MODULE_NOT_FOUND`, `ERR_ACCESS_DENIED`, a cancelled test and a timeout are never the right reason. **The innermost repo frame of the failure that is not the test file must be the anchor file within ±10 lines of the anchor line.** So a test that throws the right error type by itself, without running the buggy code, is rejected.

10. **"Small" is enforced by code; config can only lower it.** `src/domain/code-fix/limits.ts` holds the ceilings: `maxFiles: 3` (the test included), `maxSourceLines: 20` (added plus removed in source), `maxTotalLines: 50` (the test included), `maxTestLines: 40`, `maxEdits: 2`. `effectiveLimits(cfg)` is `min(cfg, ceiling)`. The guards are pure, collect every violation at once, and return `{ ok, violations: [{ code, message }] }`. They are a heuristic floor; isolation and human approval are the real controls.
    - `checkTestFile()` (`test-guard.ts`): `test_path_not_test` (must match `testGlobs`, must not match `sourceGlobs`), `path_denied`, `path_escape`, `test_file_exists` (must be new), `test_too_large`, `test_not_importing_anchor` (must import the anchor module by its relative path), `test_import_not_allowed` (only `node:test`, `node:assert`, `node:assert/strict` and relative paths that exist in the repo), `test_banned_token` (`process`, `console`, `globalThis`, `getBuiltinModule`, `import(`, `require(`, `eval`, `Function`, `Reflect`, `Proxy`, `setInterval`), `skip_marker` (`.skip`, `.only`, `.todo`, `{ skip`, `{ todo`), `test_no_assert`, `trivial_assert`, `injection_text`.
    - `checkPatch()` (`patch-guard.ts`): `path_escape`, `path_denied`, `not_source_glob`, `edits_test_file` (an edit to the test path or to any `testGlobs` path), `edit_outside_frames` (every edited file is among the event's in-app frames, and at least one hunk is within ±20 lines of the anchor line), `too_many_files`, `too_many_source_lines`, `too_many_total_lines`, `too_many_edits`, `new_import` (any added `import`, `require` or `import(`), `dangerous_call` (added `child_process`, `process.`, `fetch(`, `eval(`, `new Function`, `globalThis[`, `console.`, `node:net|http|https|dns|fs|vm|worker_threads`, `Deno.`, `Bun.`), `assert_removed`, `injection_text`.
    - `checkDiff()` re-runs the size, path and kind rules on the **real diff** from the work tree: `delete_file`, `rename_file`, `mode_change`, `binary`, `symlink`, `unexpected_file`.
    - `BUILT_IN_DENIED` (`paths.ts`): `.github/**`, `.gitlab-ci.yml`, `.circleci/**`, `**/migrations/**`, `**/migrate/**`, `**/*.sql`, `infra/**`, `terraform/**`, `**/*.tf`, `deploy/**`, `k8s/**`, `helm/**`, `**/Dockerfile*`, `**/docker-compose*`, `**/auth/**`, `**/security/**`, `**/crypto/**`, `**/session*`, `**/permission*`, `**/payment*`, `**/billing/**`, `**/secret*`, `**/.env*`, `**/*.pem`, `**/*.key`, `**/.*rc*`, `**/*.config.*`, `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `tsconfig*.json`, `.npmrc`, `.nvmrc`, `AGENTS.md`, `CONTRIBUTING.md`, `CODEOWNERS`, `**/vendor/**`, `**/node_modules/**`, `dist/**`, `build/**`. Config `deniedPaths` only adds to it.

11. **The diff comes from the work tree, never from model text.** `fix_verify` applies the edits, runs the new test twice (both must pass, else `fix_not_passing` or `fix_flaky`), then the full suite. The suite must have `failed === 0`, `total === baseline.total + newTests`, and `skipped` and `todo` no higher than the baseline. Then `git add -A` and `git diff --cached --no-ext-diff --no-color --binary --find-renames` (numstat and patch). `git status --porcelain=v1 -z --untracked-files=all` must list exactly the test path (added) and the edited source paths (modified); anything else is `unexpected_file`. `checkDiff()` runs on the result. The stored artifact is the patch, plus the **post-image of every changed file** (each at most 256 KiB, else `patch_too_large`) and its SHA-256. If `redactSecrets(patch) !== patch`, the attempt gives up with `patch_contains_secret`.

12. **The reviewer only vetoes.** `fix_review` (`fix-review.v1`) receives the fenced diff, the exception, the evidence numbers and a conventions summary, and returns `{ verdict: "approve" | "reject", concerns: string[] (≤ 5) }`. `reject`, an invalid output or an LLM failure all give up (`reviewer_rejected`, `reviewer_unavailable`). `approve` changes no other decision.

13. **The catalog entry is tier 3 and reserved.** `EXECUTABLE_ACTIONS.open_draft_pull_request`: tier 3, `mitigates: false`, `reversible: false`, `durationSec: 15`, `targetKind: "repository"`, `targetPattern: "repository/<service>"`, params `{ attemptId: /^fix_[a-z0-9]{8,40}$/, patchSha256: /^[0-9a-f]{64}$/ }`, and `proposers: ["code_fixer"]`.
    - `ActionSpec` gains an optional `proposers?: readonly Proposer[]` (`Proposer = "remediation_planner" | "mcp_client" | "code_fixer"`). `TargetKind` gains `"repository"`.
    - `ClassificationContext` gains a required `proposer`, so every caller is updated: the gate passes `remediation_planner`, `proposeExternalAction` passes `mcp_client`, the fixer passes `code_fixer`. A raise-only rule, `REASONS.reservedProposer` ("reserved for another proposer (tier 4)"), raises the tier to 4 when `proposers` excludes the caller. The planner or an MCP client proposing it is therefore `blocked_forbidden` and audited. MCP gets the refusal code `action_reserved`.
    - `catalogPromptText()` skips actions whose `proposers` exclude `remediation_planner`, so the planner prompt input and the `promptTokens` in the goldens are unchanged.
    - `fix_finalize` classifies the step with `proposer: "code_fixer"` and requires exactly tier 3 with valid params, else `catalog_refused`. The publisher classifies again before writing.
    - `EXECUTORS.open_draft_pull_request` (`simulated-infra.ts`) exists only for the type registry: its `check()` always refuses ("executed by the code-fix publisher, not the simulated world").
    - `npm run regen` changes only `docs/autonomy-matrix.md`.

14. **Code-fix approvals live in their own table.** Every consumer of `store.listApprovals` (pending counts, expiry, the escalation close-all, the graph's `pendingApprovals`, the reporter, status derivation, views, demo recordings) works on the incident's action approvals. Code-fix approvals live in `code_fix_approvals`, which none of them reads, so they cannot leak there by construction.
    - `ApprovalSchema` gains `subject: z.enum(["code_fix"]).optional()` and `patchSha256: z.string().optional()`, with no default, so action approvals stay byte-identical. For a code-fix approval, `actionId` holds the attempt id.
    - `ApprovalService.decide` keeps its order: body, token configured, lockout, constant-time token (the failure audit finds the incident id in either table), text parse. Then it looks the id up in `approvals` and, if it is not there, in `code_fix_approvals`. **It branches right after the lookup, before any expiry handling.**
    - A code-fix approval goes to `CodeFixService.decide`, which does its own expiry and pending checks. Expired: approval `expired`, attempt `expired`, audit `approval_expired` in one transaction, then 409. Then, in one transaction, it transitions the approval with an optimistic version, moves the attempt `awaiting_approval → approved | rejected`, and audits `approval_approved` or `approval_rejected` (actor `human:<approver>`, `details.subject: "code_fix"`). Approval then enqueues the publish. It never calls `IncidentService.applyDecision`, `expireDueApprovals` or `resume`.
    - It is accepted while the incident is `advised` or `resolved`, because the bug outlives the incident. `GET /approvals` merges both tables. TTL is `codeFix.approvalTtlHours` (default 72, max 168), and expiry is materialized on read and on decide.

15. **The publisher publishes exactly what was approved, idempotently.** `CodeFixPublisher.publish(attemptId)` runs only for `approved` or `publishing` attempts, sets `publishing` before the first request, and then checks, in order:
    1. `patchSha256` = SHA-256 of the canonical JSON `{ patch, files: [{ path, afterSha256 }] }` (paths sorted). Every stored post-image must hash to its `afterSha256`, and the result must equal both `attempt.patchSha256` and `approval.patchSha256`. Otherwise `patch_mismatch`.
    2. `classifyAction` gives tier 3 with valid params. Otherwise `catalog_refused`.
    3. `GET /repos/{o}/{r}/branches/{base}` must report `protected: true`. Otherwise `base_unprotected`. Branch protection is an operator duty, checked as far as the token can see.
    4. `GET /repos/{o}/{r}/compare/{baseCommitSha}...{base}` must not list a changed file. Otherwise `stale_base`, and nothing is rebased.
    5. `findPullByHead` on `incident-copilot/fix-<attemptId>`. A pull request that already exists is recorded and returned.
    6. Blobs, tree on `base_tree`, then a commit with `parents: [baseCommitSha]` and author and committer `{ name, email, date: attempt.patchReadyAt }` from `codeFix.commitAuthor`. Same inputs give the same commit SHA on every retry, and the commit SHA is persisted before `POST /git/refs`. A 422 on the ref looks it up again: it is accepted when it points at our commit, or at a commit whose tree equals ours and whose parents are `[baseCommitSha]`. Anything else is `ref_conflict`.
    7. `POST /pulls { title, head, base, body, draft: true, maintainer_can_modify: false }`.

    The outcome is `pr_opened` (audit `code_fix_pr_opened`) or `publish_failed` (audit `code_fix_publish_failed` with the kind). The commit message and the body carry no co-author or attribution lines.

16. **Attempts are idempotent per error group, and transient failures do not block it forever.** `code_fix_attempts` has a `key_held` column and a partial unique index `(repo, error_group_id) WHERE key_held = 1`.
    - `skipped` rows never hold the key. An attempt takes it when it enters `running`.
    - It releases it when it ends with a transient reason: `interrupted`, `attempt_timeout`, `sandbox_error`, `baseline_timeout`, `workspace_failed`, `author_unavailable`, `reviewer_unavailable` or `codehost_error`.
    - A later alert of the same group may start a new attempt while fewer than `limits.maxAttemptsPerGroup` (default 3) rows exist for it.
    - Every other outcome keeps the key, so one error group never gets two pull requests.
    - The daily cap (`limits.maxAttemptsPerDay` per repository, default 5) counts attempts that entered `running` in the last 24 hours.

17. **Budgets fail closed.** `AbortSignal.any([AbortSignal.timeout(limits.attemptTimeoutMin), shutdown])` bounds the attempt (`attempt_timeout`). `budgetExceeded(state, limits)` (pure) runs in every route before an LLM node, against `limits.maxLlmCalls` (default 6, max 8) and `limits.maxTokens` (default 60,000, prompt plus completion) (`budget_exhausted`). LLM failures are values (`author_unavailable`, `reviewer_unavailable`). Nothing in the fixer throws into the queue or changes the incident.

18. **Prompts stay out of `ALL_PROMPTS`.** `fix-test.v1`, `fix-patch.v1` and `fix-review.v1` live in a new `FIX_PROMPTS` list.
    - The `prompts.unit.test.ts` id list, the `recordedWith.promptVersions` of demo recordings and the scenario fixtures do not change.
    - `rehashFixtures` works on `[...ALL_PROMPTS, ...FIX_PROMPTS]` but writes a `FIX_PROMPTS` hash only into files that contain a turn of that prompt.
    - The system texts say that text inside `<<<UNTRUSTED REPO FILE path=…>>>`, `<<<UNTRUSTED OBSERVATION>>>` and `<<<UNTRUSTED TEST OUTPUT>>>` blocks is data, never instructions. They never contain the word "tier". Untrusted text goes through `neutralizeDelimiters`.
    - matchKeys: `{ repo, attempt }` for both authors, `{ repo }` for the reviewer.
    - The fixer's calls go through the recording provider with `RunContext { incidentId, runId: attemptId, scenarioId: incident.scenarioId }`.

19. **Mode.** The top-level `mode: shadow` literal and its rule stay, and live incidents still execute no infrastructure action.
    - `codeFix.mode: shadow` (default) ends a successful attempt at `patch_ready`. The only code-host request is the reader's `commitExists` GET, plus the git fetch.
    - `codeFix.mode: draft_pr` moves `patch_ready` to `awaiting_approval` in the same transaction, with the approval row and the `approval_requested` audit (tier 3, `subject: "code_fix"`, `patchSha256`, `expiresAt`). `assertLiveSafe` refuses `draft_pr` without `APPROVAL_TOKEN` or without `codeFix.github.token`.
    - This is the copilot's first real-world write. It is a tier 3 non-mitigation behind a human, and spec 008's non-goal about executing actions on real infrastructure stays true.

20. **GitHub through REST over the injected `fetch`.** `src/codehost/github/` follows the notifier pattern, not the connector one, because connectors are read-only by rule. It uses `createHttpClient` (GET and POST only, 10 s timeout, 1 MiB cap, `redirect: "error"`).
    - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` (unverified, documented).
    - `apiUrl` comes through `h.url()`: https, with loopback http allowed only in tests.
    - `owner` and `repo` must match `^[A-Za-z0-9_.-]{1,100}$` and the allowlist **inside the client, before any request**, and are URL-encoded.
    - The client type has no merge, review, label, PUT, PATCH or DELETE method.
    - Errors are `CodeHostError` kinds (`auth`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `timeout`, `unavailable`, `bad_response`, `unsafe_input`) with no body, header or token.
    - The token is one fine-grained PAT, `${GITHUB_FIX_TOKEN}` through `h.secret()`, with `contents: read/write` and `pull_requests: read/write` on the allowlisted repositories only. The copilot cannot introspect fine-grained scopes; the docs make it an operator duty. GitHub App installation tokens are a 0.6 item.

21. **All fixer text is untrusted and redacted.** Stack traces, exception messages, repository files and test output are sanitized, clipped and fenced. They are never used to choose a repository, path, commit, command, tier, approval or publication. Every text the fixer sends out (pull request title and body, diff, audit, trace, logs, notifications, API) goes through `redactSecrets`. The pull request body carries counts and test names, never test output text. `injectionScan()` (pure) over model output gives up on a hit in `fix_finalize` as well as in the guards.

22. **No new npm dependency.** `node:child_process`, `node:crypto`, `node:fs`, the `git` binary and the injected `fetch` are enough. The runtime image gains the system packages `git` (workspace) and `util-linux` (`unshare`), installed with `apt-get install --no-install-recommends`, plus a scratch directory. Before first use, the Node 24.21 facts the runner depends on are recorded in `docs/api-notes.md`: the permission flags, `--test-isolation=none` (which needs file paths or globs, not directories), the reporter `cause` shape, `module.registerHooks`, and the absence of `--allow-net`.

## Contracts

`src/contracts/code-fix.ts` (zod, browser-safe, exported through `index.ts`):

```ts
export const CodeFixModeSchema = z.enum(["shadow", "draft_pr"]);
export const CodeFixIsolationSchema = z.enum(["isolated", "best_effort"]);
export const CodeFixStatusSchema = z.enum([
  "skipped", "running", "gave_up", "patch_ready", "awaiting_approval", "approved", "rejected", "expired",
  "publishing", "pr_opened", "publish_failed",
]);
export const CodeFixStageSchema = z.enum([
  "eligibility", "locate", "workspace", "baseline", "author_test", "guard_test", "repro",
  "author_patch", "guard_patch", "verify", "review", "finalize", "publish",
]);
export const CodeFixReasonSchema = z.enum([
  // skipped (no git, no LLM)
  "not_advised", "source_unsupported", "category_not_code", "low_confidence", "service_not_allowlisted",
  "connector_unsupported", "sandbox_unavailable", "daily_cap_reached", "already_attempted", "error_event_unavailable",
  "exception_not_fixable", "not_new_in_release", "no_in_app_frame", "path_not_allowlisted", "path_denied",
  "commit_unresolved", "commit_not_found",
  // gave_up
  "workspace_failed", "file_changed_since_release", "line_out_of_range", "file_not_regular", "baseline_not_green",
  "baseline_timeout", "sandbox_error", "author_unavailable", "budget_exhausted", "attempt_timeout", "guard_rejected",
  "repro_not_failing", "repro_wrong_reason", "repro_flaky", "edit_not_applicable", "fix_not_passing", "fix_flaky",
  "suite_regressed", "test_count_dropped", "unexpected_file", "patch_too_large", "patch_contains_secret",
  "reviewer_rejected", "reviewer_unavailable", "catalog_refused", "interrupted",
  // publish_failed
  "patch_mismatch", "base_unprotected", "stale_base", "ref_conflict", "codehost_error",
]);
export const TestFailureSchema = z.object({
  name: z.string().max(200), file: z.string().max(300), errorName: z.string().max(120), message: z.string().max(200),
  frames: z.array(z.object({ file: z.string().max(300), line: z.number().int().positive() })).max(10),
});
export const TestRunSummarySchema = z.object({
  outcome: z.enum(["passed", "failed", "error", "timeout"]), exitCode: z.number().int().nullable(),
  total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(), todo: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(), failures: z.array(TestFailureSchema).max(5),
});
export const CodeFixFileSchema = z.object({
  path: z.string().max(300), role: z.enum(["test", "source"]), added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(), afterSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const CodeFixSuggestionSchema = z.object({ // built from facts for a give-up after locate
  anchor: StackFrameSchema.nullable(), exception: z.object({ type: z.string().max(120), value: z.string().max(300) }).nullable(),
  reason: CodeFixReasonSchema, modelRationale: z.string().max(600).nullable(), // labeled as unverified model text
});
export const CodeFixAttemptSchema = z.object({
  id: z.string().regex(/^fix_[a-z0-9]{8,40}$/), incidentId: z.string(), repo: z.string().max(201), service: z.string().max(120),
  connectorId: ConnectorIdSchema, errorGroupId: z.string().max(40), mode: CodeFixModeSchema, isolation: CodeFixIsolationSchema,
  status: CodeFixStatusSchema, stage: CodeFixStageSchema, reason: CodeFixReasonSchema.nullable(),
  violations: z.array(z.string().max(40)).max(40),          // guard codes only
  release: z.string().max(120).nullable(), commitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  baseBranch: z.string().max(200), baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  exception: z.object({ type: z.string().max(120), value: z.string().max(300) }).nullable(), anchor: StackFrameSchema.nullable(),
  files: z.array(CodeFixFileSchema).max(3), patch: z.string().max(20_000).nullable(), patchSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  contents: z.array(z.object({ path: z.string().max(300), text: z.string().max(262_144) })).max(3), // post-images; never in a view
  evidence: z.object({
    baseline: TestRunSummarySchema.nullable(), reproBefore: z.array(TestRunSummarySchema).max(2),
    fixAfter: z.array(TestRunSummarySchema).max(2), suiteAfter: TestRunSummarySchema.nullable(),
  }),
  review: z.object({ verdict: z.enum(["approve", "reject"]), concerns: z.array(z.string().max(200)).max(5) }).nullable(),
  suggestion: CodeFixSuggestionSchema.nullable(), approvalId: z.string().nullable(),
  commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), tree: z.string().regex(/^[0-9a-f]{40}$/) }).nullable(),
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().max(2000), branch: z.string().max(200) }).nullable(),
  llm: z.object({ calls: z.number().int().nonnegative(), promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative() }),
  startedAt: z.iso.datetime(), patchReadyAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
  version: z.number().int().nonnegative(),
});
export const CodeFixAttemptViewSchema = CodeFixAttemptSchema.omit({ contents: true }); // redacted before it leaves
export const FixTestProposalSchema = z.object({
  test: z.object({ path: z.string().max(200), content: z.string().max(6000) }), rationale: z.string().max(600),
});
export const FixPatchProposalSchema = z.object({
  edits: z.array(z.object({ path: z.string().max(200), search: z.string().min(1).max(2000), replace: z.string().max(2000) })).min(1).max(2),
  rationale: z.string().max(600),
});
export const FixReviewSchema = z.object({ verdict: z.enum(["approve", "reject"]), concerns: z.array(z.string().max(200)).max(5) });
```

No model output schema has a tier, approval, command, repository or publish field.

`src/contracts/live-telemetry.ts` additions:

```ts
export const StackFrameSchema = z.object({
  file: z.string().max(300), line: z.number().int().positive(), column: z.number().int().nonnegative().nullable(),
  function: z.string().max(120).nullable(), inApp: z.boolean(),
});
export const ErrorEventSchema = z.object({
  errorId: z.string().max(200), release: z.string().max(120).nullable(), firstSeen: iso.nullable(),
  exception: z.object({ type: z.string().max(120), value: z.string().max(300) }),
  frames: z.array(StackFrameSchema).max(50), // innermost last
});
export const ReleaseCommitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), repository: z.string().max(200).nullable() });
```

`QueryCapability` (`src/connectors/types.ts`) gains `errorEvent?({ service, errorId }, io): Promise<ErrorEvent | null>` and `releaseCommit?({ service, version }, io): Promise<ReleaseCommit | null>`. They are not `ReadToolName`s, so the LLM tools stay unchanged. Sentry's `errorEvent` reads the issue (`GET /api/0/organizations/{org}/issues/{id}/`, for `firstSeen`) and its latest event (`.../issues/{id}/events/latest/`). The mapper reads only the exception's `type`, `value` and `stacktrace.frames[]` (`filename`, `abs_path`, `lineno`, `colno`, `function`, `in_app`) and the `release` tag. It never reads `vars`, `context_line`, `pre_context`, `post_context`, `request`, `user`, `contexts` or `breadcrumbs`. `releaseCommit` reads `GET .../releases/{version}/` for `lastCommit.id` and `lastCommit.repository.name`. Both endpoints and fields are unverified, built from the docs, and handled defensively.

Ports (types only, `src/domain/code-fix/ports.ts`): `GitWorkspacePort`, `Workspace`, `SandboxRunner`, `CodeHostReader` (`commitExists`, `branchInfo`, `compareFiles`, `findPullByHead`, `getRef`, `getCommit`), `CodeHostWriter` (`openDraftPullRequest`).

Changes to existing contracts (all additive; absent values keep recordings and goldens identical):

| Contract | Change |
|---|---|
| `AgentIdSchema` | adds `code_fixer` (plus `AGENT_LABELS` and War Room labels) |
| `AuditEventSchema` | adds `code_fix_skipped`, `code_fix_started`, `code_fix_gave_up`, `code_fix_patch_ready`, `code_fix_pr_opened`, `code_fix_publish_failed`; approvals reuse `approval_*` with `details.subject` |
| `ApprovalSchema` | optional `subject: "code_fix"` and `patchSha256`, no defaults |
| `NotificationKind` | adds `code_fix_ready` and `code_fix_pr_opened`; the notifier `events` default becomes the fixed list of the four 0.4 kinds, and its max grows to 6 |
| `ActionSpec`, `TargetKind`, `ClassificationContext` | `proposers`, `"repository"`, `proposer` (decision 13) |

No change to `IncidentStatus`, `ActionStatus`, `EscalationReason`, `RootCauseCategory` or `ReadToolName`.

Database (schema version 5):
- New table `code_fix_attempts`: `id` PK, `incident_id` REFERENCES incidents, `repo`, `error_group_id`, `status` CHECK from `CodeFixStatusSchema`, `key_held` INTEGER CHECK (0, 1), `created_at`, `finished_at`, `version`, `json`. It has a partial unique index on `(repo, error_group_id) WHERE key_held = 1` and an index on `incident_id`.
- New table `code_fix_approvals`: `approvals` columns plus `attempt_id`, with `status` CHECK from `ApprovalStatusSchema`.
- **`trace_events` joins `ENUM_CHECKED_TABLES`** (its SQL moves into a builder; it rebuilds on a stale `agent` or `type` CHECK, keeping rows and the `(incident_id, seq)` uniqueness). Without this, every `code_fixer` trace write on a v4 database would fail its CHECK.
- The v4 → v5 migration keeps every row, `seq`, the audit hash chain and the append-only triggers.

`copilot.yaml` (optional strict section; absent means disabled):

```yaml
codeFix:
  enabled: true
  mode: shadow                    # shadow | draft_pr
  approvalTtlHours: 72            # 1..168
  sandbox: { network: isolated }  # isolated | best_effort
  github:
    apiUrl: https://api.github.com
    token: ${GITHUB_FIX_TOKEN}    # h.secret; required for draft_pr and for private repositories
  commitAuthor: { name: incident-copilot, email: incident-copilot@example.invalid }
  limits:                         # can only lower the ceilings in src/domain/code-fix/limits.ts
    maxConcurrent: 1              # 1..2
    maxFiles: 3                   # 1..3, test included
    maxSourceLines: 20            # 1..20
    maxTotalLines: 50             # 1..50, test included
    maxTestLines: 40              # 1..40
    maxEdits: 2                   # 1..2
    maxAuthorAttempts: 2          # 1..3, per author
    maxLlmCalls: 6                # 3..8
    maxTokens: 60000              # 1000..200000
    attemptTimeoutMin: 15         # 1..30
    testTimeoutSec: 120           # 5..600
    maxOutputBytes: 65536         # 4096..262144
    maxAttemptsPerDay: 5          # 1..20, per repository
    maxAttemptsPerGroup: 3        # 1..5
  fixableExceptionTypes: [TypeError, RangeError, ReferenceError]
  repositories:                   # max 20
    - repo: acme/checkout-web     # ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$
      service: checkout-web       # a services[].name; one repository per service
      connector: sentry           # a connector id of type sentry
      baseBranch: main            # git ref-name allowlist
      pathPrefixes: ["/app/", "app:///", "webpack:///./"]
      sourceGlobs: ["src/**/*.{js,ts}"]
      testGlobs: ["tests/**/*.test.{js,ts}"]
      testFiles: ["tests/**/*.test.js"]   # what the runner passes to node --test
      deniedPaths: ["src/pricing/**"]     # added to BUILT_IN_DENIED
```

Cross-checks in `load.ts` report fixed `{ path, rule }` problems with no value echoed: `service` exists and is unique across repositories; `connector` exists and is of type `sentry`; `repo` is unique; the globs pass their allowlist; `token` is present when `mode` is `draft_pr`. `NO_COPILOT.codeFix` is `null`.

HTTP:

| Route | Auth | Success | Errors |
|---|---|---|---|
| `GET /incidents/:id/code-fix` | `API_TOKEN` when set | 200 the latest `CodeFixAttemptView` (redacted, with `patch`, without `contents`) | 404 `incident_not_found`, 404 `code_fix_not_found` |
| `GET /approvals?status=` | unchanged | items of both tables; code-fix items carry `subject` and `patchSha256` | unchanged |
| `POST /approvals/:id/decision` | unchanged (`APPROVAL_TOKEN`, lockout, text parse) | 200 `{ approval, incident }`; the incident is unchanged by a code-fix decision | unchanged, plus 409 `code_fix_not_awaiting_approval` |
| `GET /incidents/:id/postmortem` (Markdown) | unchanged | appends the "Code fix" section only when an attempt exists | unchanged |

Audit (all details redacted; codes and numbers, never content):

| Event | Actor | Tier | Details |
|---|---|---|---|
| `code_fix_skipped` | `agent:code_fixer` | null | `attemptId`, `reason`, `requestId` |
| `code_fix_started` | `agent:code_fixer` | null | `attemptId`, `repo`, `commitSha`, `baseCommitSha`, `isolation` |
| `code_fix_gave_up` | `agent:code_fixer` | null | `attemptId`, `reason`, `stage`, `violations` |
| `code_fix_patch_ready` | `agent:code_fixer` | 3 | `attemptId`, `patchSha256`, `files` (path and counts), evidence numbers, `mode` |
| `approval_requested` | `agent:code_fixer` | 3 | `subject: "code_fix"`, `approvalId`, `attemptId`, `patchSha256`, `expiresAt` |
| `approval_approved`, `approval_rejected`, `approval_expired` | `human:<name>`, `system:approval-service` | 3 | `subject`, `approvalId`, `attemptId`, `source`, `comment` |
| `code_fix_pr_opened` | `system:code-fix-publisher` | 3 | `attemptId`, `prNumber`, `prUrl`, `branch`, `patchSha256` |
| `code_fix_publish_failed` | `system:code-fix-publisher` | 3 | `attemptId`, `reason`, `kind` |

Trace events use `agent: "code_fixer"` and the existing types: `action` and `observation` per stage, and `critique` with `by: "gate"` for guard rejections. `runId` is the attempt id.

## Non-goals

- Merging, approving, labelling, requesting reviewers, commenting on, updating or closing pull requests. One draft pull request per error group; no follow-up commits after review.
- Error sources other than Sentry (Bugsnag, New Relic, webhook, MCP), source-map resolution, minified bundles, monorepo package routing beyond `pathPrefixes`, and cross-provider correlation.
- Test frameworks other than `node --test` (Jest, Vitest, Mocha, pytest), languages other than JavaScript and TypeScript, dependency install steps and build steps.
- Container, VM or gVisor runners and a docker-socket sandbox (the `SandboxRunner` port is shaped for one in 0.6), and network isolation on hosts without user namespaces (fails closed).
- GitHub App installation tokens, separate read and write tokens, GitHub Enterprise beyond `apiUrl`, GitLab and Bitbucket.
- A `code_bug` root-cause category and any change to the incident graph, supervisor, telemetry or planner prompts.
- Editing existing test files, more than one new test file, multi-hunk refactors, config or dependency changes, rebasing a stale patch.
- Running the fixer for scenario incidents, a manual-run route, an MCP tool, a CLI command beyond `config check`, a War Room fixer view (only the labels the typecheck forces), and approvals from chat.
- Re-running a group after a reject, or after a permanent give-up.
- A CI job that exercises `unshare`: the isolated self-test case skips with a reason where user namespaces are unavailable.

## Acceptance criteria (EARS)

- **AC-60** When a live incident is persisted as `advised` and `codeFix.enabled` is true, the system shall consider a code fix in a job outside the incident graph, after the run slot is released, which holds no run slot and no `runs` row and does not write the incident blackboard.
- **AC-61** If the incident is not `advised` or is escalated, its origin is not a Sentry issue alert, its diagnosis is not `bad_deploy` with medium or high confidence, its service has no allowlisted repository, its connector lacks `errorEvent`, `releaseCommit` or `deploys`, the sandbox is unavailable, the daily cap is reached, or an attempt holds the key of its error group, then the system shall record a `skipped` attempt with a typed reason and audit `code_fix_skipped`, without calling the LLM or git, and the skipped row shall not hold the key.
- **AC-62** The system shall map the error to a repository file only from connector data: the innermost in-app frame, prefix-stripped to a safe repo-relative path inside `sourceGlobs` and outside every denied path, present with the line in range at the resolved commit, a regular file at the base head, and byte-identical at the base head; otherwise it shall skip or give up with a typed reason, and it shall never use LLM output for this mapping.
- **AC-63** When resolving the failing release, the system shall require the error group to be new in a deploy of that release and shall accept only a 40-hex SHA from the release's last commit in the allowlisted repository or from the release version, confirmed by the code host; otherwise it shall skip with `not_new_in_release`, `commit_unresolved` or `commit_not_found`.
- **AC-64** While a workspace is prepared, the system shall shallow-fetch only the allowlisted repository over https into a temporary directory, run every git command without a shell, with the host's global and system git config, hooks, symlinks, fsmonitor, submodules, LFS and credential helpers disabled, give the token to git only through a temporary askpass file, and delete the directory when the attempt ends.
- **AC-65** When target-repository tests run, the system shall start them with no shell, an allowlisted environment that holds no copilot secret, the Node permission model without child-process, worker, addon, WASI or inspector rights, read access only to the work tree, the sandbox kit and the temporary area, write access only to the temporary area outside the work tree, a timeout that kills the whole process group, and capped, redacted output; and it shall treat an empty report, zero tests or a report that contradicts the exit code as `error`.
- **AC-66** If `codeFix.sandbox.network` is `isolated` and the startup self-test cannot prove that network access, child processes, writes outside the temporary area, reads of the copilot's config and database, and inherited secrets are all denied, then the system shall disable the fixer and record every eligible incident as `skipped/sandbox_unavailable`; while the mode is `best_effort`, the system shall stamp it on the attempt, the report and the pull request body.
- **AC-67** If the baseline suite does not pass with at least one test, then the system shall give up with `baseline_not_green` or `baseline_timeout` before any LLM call.
- **AC-68** When the test author proposes a test, the system shall accept only a new file matching `testGlobs`, outside `sourceGlobs` and denied paths, of at most `maxTestLines` lines, that imports the anchor module and only `node:test`, `node:assert` and existing relative modules, and that has assertions and no skip, only or todo marker, no trivial assertion and no use of `process`, `console`, `globalThis`, dynamic import, `require`, `eval` or `Function`; it shall report every violation at once.
- **AC-69** When a test passes the guard, the system shall write only that file and run it twice before any source file is written, and shall continue only if both runs fail the new test with the same signature, with the incident's exception type or message, not with a syntax, module, permission, cancellation or timeout error, and with the innermost non-test repo frame in the anchor file within 10 lines of the anchor line; otherwise it shall give up with `repro_not_failing`, `repro_wrong_reason` or `repro_flaky` after the allowed author retries and attach a suggestion built from facts.
- **AC-70** When the patch author proposes edits, the system shall not show it the test content and shall reject edits that touch the test path, any `testGlobs` path, a denied path or a file outside the event's in-app frames, have no hunk within 20 lines of the anchor line, add an import, a process, console, environment, network, eval or filesystem call, remove an assertion, or exceed `maxFiles` (≤ 3, test included), `maxSourceLines` (≤ 20), `maxTotalLines` (≤ 50, test included) or `maxEdits` (≤ 2), reporting every violation, retrying at most `maxAuthorAttempts` times and then giving up with `guard_rejected`.
- **AC-71** When source edits are applied, the system shall continue only if the new test passes twice, the full suite has no failure, the test count equals the baseline plus the new tests, and the skipped and todo counts did not grow; and it shall compute the patch from the staged work tree, give up with `unexpected_file` when any other path changed, and re-run the size, path and file-kind rules on that patch.
- **AC-72** When the deterministic checks pass, the system shall ask the reviewer prompt for a verdict and shall give up on `reject`, invalid output or an LLM failure; a reviewer `approve` shall change no other decision.
- **AC-73** The system shall classify `open_draft_pull_request` only through `classifyAction`, as tier 3 when the code fixer proposes it and as tier 4 `blocked_forbidden` when the planner or an MCP client proposes it, shall not list it in the planner prompt, and shall request approval only when the catalog tier is exactly 3 with valid parameters.
- **AC-74** While `codeFix.mode` is `shadow`, the system shall end a successful attempt as `patch_ready`, expose the patch, the test and the evidence through `GET /incidents/:id/code-fix` and the postmortem's "Code fix" section, and send no write request to the code host.
- **AC-75** While `codeFix.mode` is `draft_pr`, when an attempt reaches `patch_ready` the system shall, in one transaction, store a pending approval with subject `code_fix` in `code_fix_approvals`, bound to the patch hash, with `approvalTtlHours`, move the attempt to `awaiting_approval` and audit `approval_requested` at tier 3; that approval shall not count in any incident's pending approvals, expiry, status or views.
- **AC-76** When a code-fix approval is decided through `POST /approvals/:id/decision`, the system shall apply the same body, token, lockout and text checks as action approvals, branch on the subject before any expiry handling, apply its own expiry and pending checks, update the approval and the attempt in one transaction, and never call the incident's decision, expiry or resume paths.
- **AC-77** When a code-fix approval is approved, the publisher shall verify the stored patch and post-images against the approved hash, re-classify the action as tier 3, require the base branch to be protected and unchanged in the patched files since the base commit, create one deterministic commit from the base commit on `incident-copilot/fix-<attemptId>`, open a pull request with `draft: true`, reuse its own existing branch or pull request on a retry, and never call a merge, review, PUT, PATCH or DELETE endpoint.
- **AC-78** The code-host client shall send requests only to the configured https API URL and only for allowlisted repositories, checked before any request, through the injected transport with timeout, response cap and no redirects, and shall map failures to fixed error kinds that contain no body, header or token.
- **AC-79** The system shall pass every text that leaves the process from the fixer (pull request title and body, commit message, diff, test output, audit, trace, logs, notifications, API) through `redactSecrets`, keep test output text out of the pull request body, and give up with `patch_contains_secret` when redaction would change the patch.
- **AC-80** The system shall treat stack traces, exception messages, repository files and test output as untrusted: sanitized, clipped, given to the model only inside untrusted delimiters, scanned for injection markers in model output, and never used to choose a repository, path, commit, command, tier, approval or publication.
- **AC-81** If an attempt exceeds `attemptTimeoutMin`, `maxLlmCalls` or `maxTokens`, or an LLM call fails, then the system shall give up with `attempt_timeout`, `budget_exhausted`, `author_unavailable` or `reviewer_unavailable` without throwing and without changing the incident; and if the process restarts during an attempt, the system shall end it as `gave_up/interrupted` and retry a publish in progress idempotently.
- **AC-82** The system shall make at most one key-holding attempt per `(repo, errorGroupId)`, release the key only on a transient give-up, start no more than `maxAttemptsPerGroup` attempts per group and `maxAttemptsPerDay` per repository, and never open two pull requests for one error group.
- **AC-83** When an attempt reaches `patch_ready` or `awaiting_approval`, or a pull request is opened, the system shall send a redacted `code_fix_ready` or `code_fix_pr_opened` message only to notifiers that list that kind in `events`; the default `events` of a notifier shall stay the four 0.4 kinds.
- **AC-84** When the copilot config declares `codeFix`, the loader shall validate it strictly, accept limits only up to their ceilings, take the token only as a whole `${VAR}` secret joined to the redaction list, cross-check services, connectors, repositories and globs, and report problems as `{ path, rule }` without values; `assertLiveSafe` shall refuse `draft_pr` without `APPROVAL_TOKEN` or a token.
- **AC-85** If `codeFix` is absent or disabled, then the system shall behave as in 0.4: scenario tool descriptions, metrics goldens, audit sequences, demo recordings and existing fixture prompt hashes stay byte-identical, and a v4 database migrates to v5 keeping every row and the audit hash chain, with `trace_events` accepting the new agent.

## How to verify

| Criterion | Tests |
|---|---|
| AC-60 | `tests/unit/code-fix-service.unit.test.ts` (blackboard version and run slots unchanged); `tests/e2e/code-fix.e2e.test.ts` |
| AC-61, AC-82 | `tests/unit/code-fix-eligibility.unit.test.ts` (at least 20 must-skip cases, one eligible); `tests/unit/code-fix-store.unit.test.ts`; `tests/unit/code-fix-service.unit.test.ts` |
| AC-62, AC-63 | `tests/unit/code-fix-frames.unit.test.ts`; `tests/unit/code-fix-locate.unit.test.ts`; `tests/unit/connectors-sentry-query.unit.test.ts` |
| AC-64 | `tests/e2e/code-fix-git-workspace.e2e.test.ts` (hostile hook, symlink, hostile `HOME/.gitconfig`, token absent from argv and `.git/config`) |
| AC-65, AC-66 | `tests/unit/code-fix-sandbox-argv.unit.test.ts`; `tests/e2e/code-fix-sandbox.e2e.test.ts` (real child; `unshare` case skips with a reason where unavailable) |
| AC-67, AC-69, AC-71, AC-72, AC-81 | `tests/unit/code-fix-repro.unit.test.ts`; `tests/unit/code-fix-routing.unit.test.ts`; `tests/unit/code-fix-graph.unit.test.ts` |
| AC-68, AC-70 | `tests/unit/code-fix-test-guard.unit.test.ts`; `tests/unit/code-fix-patch-guard.unit.test.ts` |
| AC-73 | `tests/unit/autonomy.unit.test.ts`; `tests/unit/nodes-gate.unit.test.ts`; `tests/e2e/mcp.e2e.test.ts`; `tests/unit/docs-matrix.unit.test.ts` |
| AC-74, AC-75 | `tests/e2e/code-fix.e2e.test.ts`; `tests/unit/code-fix-section.unit.test.ts` |
| AC-76 | `tests/unit/code-fix-approval.unit.test.ts` |
| AC-77, AC-78 | `tests/unit/code-fix-publisher.unit.test.ts`; `tests/unit/github-codehost.unit.test.ts` |
| AC-79, AC-80 | `tests/unit/code-fix-pr-body.unit.test.ts`; `tests/unit/prompts.unit.test.ts`; `tests/e2e/code-fix.e2e.test.ts` (injection and secret scan) |
| AC-83 | `tests/unit/notifiers-slack.unit.test.ts`; `tests/unit/notification-service.unit.test.ts`; `tests/unit/copilot-config.unit.test.ts` |
| AC-84 | `tests/unit/copilot-config.unit.test.ts`; `tests/e2e/cli.e2e.test.ts` (`config check`) |
| AC-85 | `tests/unit/store-migration.unit.test.ts`; `tests/e2e/scenarios.e2e.test.ts`; `tests/e2e/demo-recordings.e2e.test.ts`; `tests/e2e/live-incident.e2e.test.ts`; `tests/unit/contracts.unit.test.ts` |

Demonstrable milestone: `npm test` runs `tests/e2e/code-fix.e2e.test.ts`. A Sentry webhook opens a live incident on the `tiny-cart` fixture repository. A real `node --test` fails twice before the patch and passes after it. In shadow mode the postmortem shows the "Code fix" section with zero GitHub writes; in `draft_pr` mode an approval opens a draft pull request against the fake GitHub.

## Reference

Sentry and GitHub facts and their sources are in `docs/connectors/sentry.md` and `docs/code-fixer.md`; facts not confirmed in the provider's documentation are marked unverified there and handled defensively in code. Node 24.21 permission-model and test-runner facts are in `docs/api-notes.md`.
