// Spec 009, decision 7: the sandbox's NDJSON test reporter. Self-contained (only node:* imports), copied into
// <attempt>/kit/ and loaded with --test-reporter. One prefixed line per test, then one summary line when the event
// stream ends. The parent reads only these lines and cross-checks them with the exit code (parseReport). Paths stay
// absolute here; the parent makes them repo-relative and drops every frame outside the work tree.
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Must equal SANDBOX_REPORT_PREFIX in sandbox-argv.ts (the kit cannot import it). */
const PREFIX = "@@incident-copilot-sandbox-report@@ ";
const MAX_RAW_FRAMES = 50;
const MAX_TEXT = 2000;

type Frame = { file: string; line: number };
type Status = "passed" | "failed" | "skipped" | "todo" | "cancelled";

function clip(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : "";
  return s.length <= max ? s : s.slice(0, max);
}

function toPath(location: string): string {
  if (location.startsWith("file://")) {
    try {
      return fileURLToPath(location);
    } catch {
      return "";
    }
  }
  return location;
}

/** `at fn (file:///a/b.js:2:3)`, `at file:///a/b.js:2:3`, `at /a/b.js:2:3`; innermost first, as in the stack. */
function framesOf(stack: unknown): Frame[] {
  if (typeof stack !== "string") return [];
  const out: Frame[] = [];
  for (const raw of stack.split("\n")) {
    if (out.length >= MAX_RAW_FRAMES) break;
    const m = /^\s+at (?:.*? \()?((?:file:\/\/)?\/[^()]*?):(\d+):(\d+)\)?\s*$/.exec(raw);
    if (!m) continue;
    const file = toPath(m[1] ?? "");
    const line = Number(m[2]);
    if (file.length > 0 && Number.isInteger(line) && line > 0) out.push({ file, line });
  }
  return out;
}

type ErrorLike = { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; cause?: unknown; failureType?: unknown };

function asErrorLike(value: unknown): ErrorLike | null {
  return value !== null && typeof value === "object" ? (value as ErrorLike) : null;
}

/** A plain `Error` with a Node code (`ERR_MODULE_NOT_FOUND`, `ERR_ACCESS_DENIED`) is named by its code. */
function errorNameOf(e: ErrorLike): string {
  const name = typeof e.name === "string" ? e.name : "Error";
  if (name === "Error" && typeof e.code === "string" && /^ERR_[A-Z0-9_]+$/.test(e.code)) return e.code;
  return name;
}

type TestEventData = {
  name?: unknown;
  file?: unknown;
  nesting?: unknown;
  entryFile?: unknown;
  skip?: unknown;
  todo?: unknown;
  details?: { type?: unknown; error?: unknown };
};

function marked(v: unknown): boolean {
  return v !== undefined && v !== false;
}

function record(type: "test:pass" | "test:fail", data: TestEventData): string {
  let status: Status;
  let errorName = "";
  let message = "";
  let frames: Frame[] = [];
  if (marked(data.todo)) status = "todo";
  else if (marked(data.skip)) status = "skipped";
  else if (type === "test:pass") status = "passed";
  else status = "failed";
  if (type === "test:fail" && status === "failed") {
    // A failing test: details.error is ERR_TEST_FAILURE with the thrown value as `cause`; a file that fails to load
    // (syntax, missing module) carries the raw error instead.
    const outer = asErrorLike(data.details?.error);
    const failureType = outer && typeof outer.failureType === "string" ? outer.failureType : "";
    if (failureType === "testTimeoutFailure" || failureType === "cancelledByParent") {
      status = "cancelled";
      errorName = failureType === "testTimeoutFailure" ? "TestTimeoutFailure" : "TestCancelled";
      message = clip(outer?.message, MAX_TEXT);
    } else {
      const inner = outer && outer.code === "ERR_TEST_FAILURE" ? asErrorLike(outer.cause) : outer;
      if (inner) {
        errorName = clip(errorNameOf(inner), MAX_TEXT);
        message = clip(inner.message, MAX_TEXT);
        frames = framesOf(inner.stack);
      } else {
        errorName = "NonErrorThrown";
      }
    }
  }
  const rec = {
    kind: "test",
    name: clip(data.name, MAX_TEXT),
    file: typeof data.file === "string" ? data.file : "",
    status,
    errorName,
    message,
    frames,
  };
  return PREFIX + JSON.stringify(rec) + "\n";
}

type TestEvent = { type: string; data?: unknown };

/**
 * Node reports a test file that declares no test as one passing top-level test named after the file. It is not a test
 * (AC-67 needs at least one), so it is dropped; a file that fails to load stays a failure.
 */
function filePseudoPass(type: string, data: TestEventData): boolean {
  if (type !== "test:pass" || marked(data.skip) || marked(data.todo)) return false;
  if (data.nesting !== 0 || data.entryFile !== undefined || typeof data.file !== "string" || typeof data.name !== "string") return false;
  const file = toPath(data.file);
  return data.name === file || data.name === relative(process.cwd(), file);
}

export default async function* sandboxReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = (event.data ?? {}) as TestEventData;
    if (data.details?.type === "suite") continue;
    if (filePseudoPass(event.type, data)) continue;
    yield record(event.type, data);
  }
  // Written only when the event stream ends normally: a crash, a kill or process.exit leaves no summary line.
  yield PREFIX + JSON.stringify({ kind: "summary" }) + "\n";
}
