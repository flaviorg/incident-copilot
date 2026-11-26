import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReproduction, sameSignature, verifyOutcome } from "../../src/domain/code-fix/repro.ts";
import { budgetExceeded } from "../../src/domain/code-fix/budget.ts";
import type { TestFailure, TestRunSummary } from "../../src/contracts/index.ts";

const TEST_PATH = "tests/cart-total.test.js";
const ANCHOR = { file: "src/cart.js", line: 42 };
const EXCEPTION = { type: "TypeError", value: "Cannot read properties of undefined (reading 'price')" };

function failure(over: Partial<TestFailure> = {}): TestFailure {
  return {
    name: "total handles a missing item",
    file: TEST_PATH,
    errorName: "TypeError",
    message: "Cannot read properties of undefined (reading 'price')",
    frames: [{ file: "src/cart.js", line: 44 }, { file: TEST_PATH, line: 7 }],
    ...over,
  };
}

function run(over: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: "failed", exitCode: 1, total: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0, durationMs: 30,
    failures: [failure()],
    ...over,
  };
}

function passing(over: Partial<TestRunSummary> = {}): TestRunSummary {
  return run({ outcome: "passed", exitCode: 0, passed: 1, failed: 0, failures: [], ...over });
}

// ---------- classifyReproduction ----------

test("classifyReproduction: right_reason when both runs fail the new test with the exception type", () => {
  assert.equal(classifyReproduction([run(), run()], EXCEPTION, ANCHOR, TEST_PATH), "right_reason");
});

test("classifyReproduction: right_reason by the message prefix when the error name differs", () => {
  const f = failure({ errorName: "Error", message: "Cannot read properties of undefined (reading 'qty')" });
  const r = run({ failures: [f] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "right_reason");
});

test("classifyReproduction: wrong_reason when neither the name nor the message prefix match", () => {
  const r = run({ failures: [failure({ errorName: "AssertionError", message: "Expected values to be strictly equal" })] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

for (const errorName of ["SyntaxError", "ERR_MODULE_NOT_FOUND", "ERR_ACCESS_DENIED"]) {
  test(`classifyReproduction: ${errorName} is never the right reason`, () => {
    const r = run({ failures: [failure({ errorName })] });
    assert.equal(classifyReproduction([r, r], { type: errorName, value: EXCEPTION.value }, ANCHOR, TEST_PATH), "wrong_reason");
  });
}

test("classifyReproduction: a module or permission code in the message is never the right reason", () => {
  const r = run({ failures: [failure({ errorName: "Error", message: "ERR_ACCESS_DENIED Cannot read properties of undefined" })] });
  assert.equal(classifyReproduction([r, r], { type: "Error", value: EXCEPTION.value }, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: a cancelled test is the wrong reason", () => {
  const r = run({ cancelled: 1 });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: a timeout is the wrong reason", () => {
  const r = run({ outcome: "timeout", exitCode: null });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: an error outcome (contradicting report) is the wrong reason", () => {
  const r = run({ outcome: "error" });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: right type thrown from another file is the wrong reason", () => {
  const r = run({ failures: [failure({ frames: [{ file: "src/other.js", line: 42 }, { file: TEST_PATH, line: 7 }] })] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: right type more than 10 lines from the anchor is the wrong reason", () => {
  const far = run({ failures: [failure({ frames: [{ file: "src/cart.js", line: 53 }, { file: TEST_PATH, line: 7 }] })] });
  assert.equal(classifyReproduction([far, far], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
  const edge = run({ failures: [failure({ frames: [{ file: "src/cart.js", line: 32 }] })] });
  assert.equal(classifyReproduction([edge, edge], EXCEPTION, ANCHOR, TEST_PATH), "right_reason");
});

test("classifyReproduction: a test that throws by itself (only test-file frames) is the wrong reason", () => {
  const r = run({ failures: [failure({ frames: [{ file: TEST_PATH, line: 7 }] })] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: test-file frames before the anchor frame are skipped", () => {
  const r = run({ failures: [failure({ frames: [{ file: TEST_PATH, line: 3 }, { file: "src/cart.js", line: 40 }] })] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "right_reason");
});

test("classifyReproduction: a failure in another file as well is the wrong reason", () => {
  const r = run({ total: 2, failed: 2, failures: [failure(), failure({ file: "tests/other.test.js", name: "other" })] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "wrong_reason");
});

test("classifyReproduction: not_failing when the new test passes", () => {
  assert.equal(classifyReproduction([passing(), passing()], EXCEPTION, ANCHOR, TEST_PATH), "not_failing");
});

test("classifyReproduction: not_failing when another test fails but the new one passes", () => {
  const r = run({ total: 2, passed: 1, failed: 1, failures: [failure({ file: "tests/other.test.js", name: "other" })] });
  assert.equal(classifyReproduction([r, r], EXCEPTION, ANCHOR, TEST_PATH), "not_failing");
});

test("classifyReproduction: not_failing with no runs", () => {
  assert.equal(classifyReproduction([], EXCEPTION, ANCHOR, TEST_PATH), "not_failing");
});

test("classifyReproduction: flaky when one run fails and the other passes", () => {
  assert.equal(classifyReproduction([run(), passing()], EXCEPTION, ANCHOR, TEST_PATH), "flaky");
});

test("classifyReproduction: flaky when the signatures of the two runs differ", () => {
  const other = run({ failures: [failure({ frames: [{ file: "src/cart.js", line: 45 }] })] });
  assert.equal(classifyReproduction([run(), other], EXCEPTION, ANCHOR, TEST_PATH), "flaky");
});

test("classifyReproduction: a single run is not enough to be the right reason", () => {
  assert.equal(classifyReproduction([run()], EXCEPTION, ANCHOR, TEST_PATH), "flaky");
});

// ---------- sameSignature ----------

test("sameSignature: equal name, file, error name and frames", () => {
  assert.equal(sameSignature(failure(), failure()), true);
  assert.equal(sameSignature(failure(), failure({ message: "Cannot read properties of undefined (reading 'qty')" })), true);
  assert.equal(sameSignature(failure(), failure({ errorName: "RangeError" })), false);
  assert.equal(sameSignature(failure(), failure({ name: "another" })), false);
  assert.equal(sameSignature(failure(), failure({ file: "tests/x.test.js" })), false);
  assert.equal(sameSignature(failure(), failure({ frames: [{ file: "src/cart.js", line: 44 }] })), false);
});

// ---------- verifyOutcome ----------

const BASELINE = passing({ total: 10, passed: 10 });

test("verifyOutcome: ok when the fix passes twice and the suite grows by the new tests", () => {
  const after = passing({ total: 11, passed: 11 });
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], after, 1), "ok");
});

test("verifyOutcome: fix_not_passing when no fix run passes", () => {
  assert.equal(verifyOutcome(BASELINE, [run(), run()], passing({ total: 11 }), 1), "fix_not_passing");
  assert.equal(verifyOutcome(BASELINE, [], passing({ total: 11 }), 1), "fix_not_passing");
});

test("verifyOutcome: fix_flaky when only one fix run passes", () => {
  assert.equal(verifyOutcome(BASELINE, [passing(), run()], passing({ total: 11 }), 1), "fix_flaky");
  assert.equal(verifyOutcome(BASELINE, [passing()], passing({ total: 11 }), 1), "fix_flaky");
});

test("verifyOutcome: fix_flaky when the two passing fix runs report different results", () => {
  // Defense in depth against an in-process forgery that rewrites the report differently per run.
  assert.equal(verifyOutcome(BASELINE, [passing(), passing({ total: 2, passed: 2 })], passing({ total: 11, passed: 11 }), 1), "fix_flaky");
  assert.equal(verifyOutcome(BASELINE, [passing(), passing({ total: 2, passed: 1, skipped: 1 })], passing({ total: 11, passed: 11 }), 1), "fix_flaky");
});

test("verifyOutcome: a timeout or error fix run does not pass", () => {
  assert.equal(verifyOutcome(BASELINE, [passing({ outcome: "timeout" }), passing({ outcome: "error" })], passing({ total: 11 }), 1), "fix_not_passing");
});

test("verifyOutcome: suite_regressed when the suite after the fix has a failure or did not pass", () => {
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], run({ total: 11, passed: 10, failed: 1 }), 1), "suite_regressed");
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], passing({ total: 11, outcome: "timeout" }), 1), "suite_regressed");
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], null, 1), "suite_regressed");
});

test("verifyOutcome: test_count_dropped when the total is not baseline plus new tests", () => {
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], passing({ total: 10, passed: 10 }), 1), "test_count_dropped");
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], passing({ total: 12, passed: 12 }), 1), "test_count_dropped");
});

test("verifyOutcome: test_count_dropped when the skipped or todo count grew", () => {
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], passing({ total: 11, passed: 10, skipped: 1 }), 1), "test_count_dropped");
  assert.equal(verifyOutcome(BASELINE, [passing(), passing()], passing({ total: 11, passed: 10, todo: 1 }), 1), "test_count_dropped");
});

// ---------- budgetExceeded ----------

const LIMITS = { maxLlmCalls: 6, maxTokens: 60_000 };
const llm = (calls: number, promptTokens: number, completionTokens: number) => ({ llm: { calls, promptTokens, completionTokens } });

test("budgetExceeded: under both limits", () => {
  assert.equal(budgetExceeded(llm(5, 40_000, 19_999), LIMITS), false);
});

test("budgetExceeded: at and over maxLlmCalls", () => {
  assert.equal(budgetExceeded(llm(6, 0, 0), LIMITS), true);
  assert.equal(budgetExceeded(llm(7, 0, 0), LIMITS), true);
});

test("budgetExceeded: at and over maxTokens (prompt plus completion)", () => {
  assert.equal(budgetExceeded(llm(1, 50_000, 10_000), LIMITS), true);
  assert.equal(budgetExceeded(llm(1, 60_001, 0), LIMITS), true);
});
