import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../../src/domain/guards/circuit-breaker.ts";
import { ActionRateLimiter } from "../../src/domain/guards/action-rate-limiter.ts";
import { TokenAttemptLimiter } from "../../src/domain/guards/token-attempt-limiter.ts";

const t = (sec: number) => new Date(Date.UTC(2026, 9, 4, 10, 0, sec));

test("breaker opens after 3 consecutive failures, cools down and half-opens", () => {
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownSec: 300 });
  assert.equal(b.state(t(0)), "closed");
  assert.equal(b.recordFailure(t(0)), false);
  assert.equal(b.recordFailure(t(1)), false);
  assert.equal(b.recordFailure(t(2)), true);
  assert.equal(b.state(t(100)), "open");
  assert.equal(b.canExecute(t(100)), false);
  assert.equal(b.state(t(303)), "half_open");
  assert.equal(b.canExecute(t(303)), true);
  assert.equal(b.canExecute(t(304)), false);
  b.recordSuccess(t(305));
  assert.equal(b.state(t(305)), "closed");
  assert.equal(b.canExecute(t(305)), true);
});

test("a success resets the consecutive count", () => {
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownSec: 300 });
  b.recordFailure(t(0));
  b.recordFailure(t(1));
  b.recordSuccess(t(2));
  assert.equal(b.recordFailure(t(3)), false);
  assert.equal(b.state(t(3)), "closed");
});

test("half-open failure reopens", () => {
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownSec: 300 });
  for (let i = 0; i < 3; i++) b.recordFailure(t(i));
  assert.equal(b.canExecute(t(310)), true);
  assert.equal(b.recordFailure(t(320)), true);
  assert.equal(b.state(t(321)), "open");
  assert.equal(b.canExecute(t(619)), false);
  assert.equal(b.state(t(620)), "half_open");
  // Falha registrada com o breaker já aberto não reabre nem conta como nova abertura.
  const c = new CircuitBreaker({ failureThreshold: 1, cooldownSec: 300 });
  assert.equal(c.recordFailure(t(0)), true);
  assert.equal(c.recordFailure(t(10)), false);
  assert.equal(c.state(t(300)), "half_open");
});

test("rate limiter: 5 per minute globally and 1 per action and target in 10 min", () => {
  const l = new ActionRateLimiter({ perMinute: 5, repeatWindowMin: 10 });
  for (let i = 0; i < 5; i++) assert.equal(l.tryAcquire("a", `t${i}`, t(i)).ok, true);
  assert.deepEqual(l.tryAcquire("a", "t9", t(10)), { ok: false, reason: "global" });
  assert.deepEqual(l.tryAcquire("a", "t0", t(70)), { ok: false, reason: "repeat" });
  assert.equal(l.tryAcquire("b", "t0", t(70)).ok, true); // outra ação no mesmo alvo
  assert.equal(l.tryAcquire("a", "t0", t(601)).ok, true);
});

test("token attempts: 5 failures in 10 min lock for 10 min", () => {
  const k = new TokenAttemptLimiter();
  for (let i = 0; i < 4; i++) k.recordFailure(t(i * 60));
  assert.equal(k.isLocked(t(239)), false);
  k.recordFailure(t(240));
  assert.equal(k.isLocked(t(300)), true);
  assert.equal(k.isLocked(t(240 + 601)), false);
  // Falhas espalhadas além da janela de 10 min não bloqueiam.
  const spread = new TokenAttemptLimiter({ maxFailures: 3, windowMin: 10, lockMin: 10 });
  spread.recordFailure(t(0));
  spread.recordFailure(t(300));
  spread.recordFailure(t(601));
  assert.equal(spread.isLocked(t(602)), false);
  spread.recordFailure(t(700));
  assert.equal(spread.isLocked(t(701)), true);
});
