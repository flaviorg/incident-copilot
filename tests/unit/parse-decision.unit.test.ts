import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVE_TERMS, normalizeDecisionText, parseDecision, REJECT_TERMS } from "../../src/domain/approval/parse-decision.ts";

for (const [text, want] of [["aprovar", "approve"], ["Aprovo", "approve"], ["  SIM. ", "approve"], ["yes", "approve"], ["aprovado?", "approve"],
  ["Não", "reject"], ["NO!", "reject"], ["rejeito", "reject"]] as const) test(`accepts ${JSON.stringify(text)}`, () => assert.equal(parseDecision(text), want));

for (const text of ["sim, mas espera", "não sei", "pode aprovar?", "nao aprovar", "", "   ", "aprovar agora", "sim sim", "ok", "talvez", "approve it",
  "y", "s", "1", "true", "aprova", "rejeitar depois", "não, aprovar", "sim não", "👍"]) test(`ambiguous ${JSON.stringify(text)}`, () => assert.equal(parseDecision(text), "ambiguous"));

test("term lists are the ones of the spec 6.5", () => {
  assert.deepEqual([...APPROVE_TERMS], ["aprovar", "aprovo", "aprovado", "sim", "approve", "yes"]);
  assert.deepEqual([...REJECT_TERMS], ["rejeitar", "rejeito", "rejeitado", "nao", "reject", "no"]);
});

test("normalization: no accents, lower case, punctuation trimmed only at the ends, spaces collapsed", () => {
  assert.equal(normalizeDecisionText("  ¡Não,   APROVAR!!  "), "nao, aprovar");
  assert.equal(normalizeDecisionText("Rejeitádo..."), "rejeitado");
  assert.equal(normalizeDecisionText("\tsim\n"), "sim");
});
