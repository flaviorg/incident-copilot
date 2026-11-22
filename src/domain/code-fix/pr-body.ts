// Draft pull request title and body (spec 009, decisions 15 and 21; AC-79). Pure. The body carries a hidden marker,
// facts, counts and test names, never test output text or failure messages, and no co-author or attribution line.
// Every untrusted string is sanitized, clipped and put in an inline code span with backticks and angle brackets
// neutralized, so it can neither break the Markdown nor forge the marker. The caller applies `redactSecrets` to the
// title and body before they leave the process.
import type { CodeFixAttempt, CodeFixAttemptView, TestRunSummary } from "../../contracts/index.ts";
import { sanitizeText } from "../ingest/sanitize.ts";

export const MAX_PR_BODY_CHARS = 60_000;
export const MAX_PR_TITLE_CHARS = 120;
const CLIP_NOTE = "\n\n…(clipped)\n";

type AttemptLike = CodeFixAttempt | CodeFixAttemptView;
export type PullRequestLinks = { incidentUrl: string };

/** One-line untrusted text: sanitized, clipped, no newline, backticks and angle brackets replaced. */
export function plainText(text: string, max: number): string {
  return sanitizeText(text, max).replace(/\n/g, " ").replaceAll("`", "'").replaceAll("<", "‹").replaceAll(">", "›");
}

/** Untrusted text as one inline code span. */
export function inlineCode(text: string, max: number): string {
  return "`" + plainText(text, max) + "`";
}

/** A link target from config: whitespace, parentheses, angle brackets and backticks percent-encoded. */
function safeUrl(url: string): string {
  return url.replace(/[\s()<>`]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

function failedRuns(runs: readonly TestRunSummary[]): number {
  return runs.filter((r) => r.failed > 0).length;
}

function passedRuns(runs: readonly TestRunSummary[]): number {
  return runs.filter((r) => r.outcome === "passed" && r.failed === 0).length;
}

function suiteLine(label: string, s: TestRunSummary | null): string {
  if (s === null) return `- ${label}: not run`;
  return `- ${label}: ${s.passed} passed of ${s.total} tests (${s.failed} failed, ${s.skipped} skipped, ${s.todo} todo)`;
}

/** Names of the new tests, from the reporter's structured failures before the fix (names only, never messages). */
export function newTestNames(attempt: AttemptLike): string[] {
  const testPaths = new Set(attempt.files.filter((f) => f.role === "test").map((f) => f.path));
  const names: string[] = [];
  for (const run of attempt.evidence.reproBefore) {
    for (const f of run.failures) {
      if (testPaths.size > 0 && !testPaths.has(f.file)) continue;
      if (!names.includes(f.name)) names.push(f.name);
    }
  }
  return names.slice(0, 5);
}

/** Evidence as counts only. */
export function evidenceLines(attempt: AttemptLike): string[] {
  const { baseline, reproBefore, fixAfter, suiteAfter } = attempt.evidence;
  const lines = [
    suiteLine("Baseline suite", baseline),
    `- Regression test before the fix: failed in ${failedRuns(reproBefore)} of ${reproBefore.length} runs`,
    `- Regression test after the fix: passed in ${passedRuns(fixAfter)} of ${fixAfter.length} runs`,
    suiteLine("Suite after the fix", suiteAfter),
  ];
  const names = newTestNames(attempt);
  if (names.length > 0) lines.push(`- New tests: ${names.map((n) => inlineCode(n, 200)).join(", ")}`);
  return lines;
}

export function fileTable(attempt: AttemptLike): string[] {
  if (attempt.files.length === 0) return [];
  return [
    "| File | Role | Added | Removed |",
    "|---|---|---|---|",
    ...attempt.files.map((f) => `| ${inlineCode(f.path, 300)} | ${f.role} | +${f.added} | -${f.removed} |`),
  ];
}

export function isolationLine(attempt: AttemptLike): string {
  return attempt.isolation === "best_effort"
    ? "- Sandbox network: **best_effort**: the test runs were not network-isolated by the operating system"
    : "- Sandbox network: isolated (operating-system network namespace)";
}

export function exceptionLine(attempt: AttemptLike): string | null {
  if (attempt.exception === null) return null;
  return `- Exception: ${inlineCode(attempt.exception.type, 120)}: ${inlineCode(attempt.exception.value, 200)}`;
}

export function anchorLine(attempt: Pick<AttemptLike, "anchor">): string | null {
  const a = attempt.anchor;
  if (a === null) return null;
  const fn = a.function === null ? "" : ` in ${inlineCode(a.function, 120)}`;
  return `- Location: ${inlineCode(`${a.file}:${a.line}`, 310)}${fn}`;
}

export function clipPullRequestBody(body: string): string {
  if (body.length <= MAX_PR_BODY_CHARS) return body;
  return body.slice(0, MAX_PR_BODY_CHARS - CLIP_NOTE.length) + CLIP_NOTE;
}

export function renderPullRequestTitle(attempt: AttemptLike): string {
  const type = attempt.exception === null ? "error" : plainText(attempt.exception.type, 60);
  const where = attempt.anchor === null ? "" : ` in ${plainText(attempt.anchor.file, 80)}`;
  const title = `fix(${plainText(attempt.service, 40)}): ${type}${where}`;
  return title.length <= MAX_PR_TITLE_CHARS ? title : title.slice(0, MAX_PR_TITLE_CHARS - 1) + "…";
}

export function renderPullRequestBody(attempt: AttemptLike, links: PullRequestLinks): string {
  const marker = `<!-- incident-copilot:attempt=${attempt.id} sha256=${attempt.patchSha256 ?? "none"} -->`;
  const facts = [
    `- Incident: [${plainText(attempt.incidentId, 60)}](${safeUrl(links.incidentUrl)})`,
    exceptionLine(attempt),
    anchorLine(attempt),
    attempt.release === null ? null : `- Release: ${inlineCode(attempt.release, 120)}`,
    attempt.commitSha === null ? null : `- Release commit: \`${attempt.commitSha}\``,
    attempt.baseCommitSha === null ? null : `- Base: ${inlineCode(attempt.baseBranch, 200)} at \`${attempt.baseCommitSha}\``,
    isolationLine(attempt),
    attempt.review === null ? null : `- Reviewer verdict: ${attempt.review.verdict}`,
  ].filter((l): l is string => l !== null);
  const body = [
    marker,
    "## Proposed fix",
    "",
    "A regression test that reproduces the incident's error and the smallest source change that makes it pass.",
    "",
    ...facts,
    "",
    "### Evidence",
    "",
    ...evidenceLines(attempt),
    "",
    "### Files",
    "",
    ...fileTable(attempt),
    "",
    "---",
    "",
    "Draft opened after human approval; incident-copilot never merges.",
    "",
  ].join("\n");
  return clipPullRequestBody(body);
}
