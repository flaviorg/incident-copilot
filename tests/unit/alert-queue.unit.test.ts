// Live alert queue and run slots (spec 008; AC-48 and AC-55): shared cap with HTTP, per-fingerprint order, failure
// isolation, capacity and drain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunSlots } from "../../src/app/run-slots.ts";
import { createAlertQueue } from "../../src/app/alert-queue.ts";
import type { AlertJob } from "../../src/app/alert-queue.ts";
import { createLogger } from "../../src/infra/logger.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const job = (alertId: string, fingerprint: string, connectorId = "prom"): AlertJob => ({ alertId, connectorId, fingerprint });
const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};

test("run slots: tryAcquire, FIFO acquire, release once", async () => {
  const s = createRunSlots(2);
  const a = s.tryAcquire()!;
  const b = s.tryAcquire()!;
  assert.equal(s.tryAcquire(), null);
  assert.equal(s.inUse(), 2);
  const order: string[] = [];
  void s.acquire().then((r) => { order.push("w1"); r(); });
  void s.acquire().then((r) => { order.push("w2"); r(); });
  a();
  a(); // a second call is a no-op
  await tick();
  assert.deepEqual(order, ["w1", "w2"]);
  assert.equal(s.inUse(), 1);
  b();
  assert.equal(s.inUse(), 0);
  assert.throws(() => createRunSlots(0), RangeError);
});

test("concurrency never exceeds the slots, also while HTTP holds one", async () => {
  const slots = createRunSlots(2);
  const http = slots.tryAcquire()!; // a POST /incidents run
  let concurrent = 0;
  let peak = 0;
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const q = createAlertQueue({
    slots, maxQueued: 10, logger: createLogger({ level: "error", secrets: [], write: () => {} }),
    handle: async (j) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      const g = deferred();
      gates.set(j.alertId, g);
      await g.p;
      concurrent -= 1;
    },
  });
  for (const id of ["A1", "A2", "A3"]) q.enqueue(job(id, id));
  await tick();
  assert.equal(concurrent, 1, "one slot left for the queue");
  http();
  await tick();
  assert.equal(concurrent, 2);
  assert.equal(slots.tryAcquire(), null, "HTTP gets 429 while the queue holds every slot");
  for (const g of gates.values()) g.resolve();
  await tick();
  for (const g of gates.values()) g.resolve();
  await q.idle();
  assert.equal(peak, 2);
  assert.equal(slots.inUse(), 0);
});

test("jobs of one fingerprint run in arrival order, one at a time; other fingerprints in parallel", async () => {
  const log: string[] = [];
  const q = createAlertQueue({
    slots: createRunSlots(4), maxQueued: 10, logger: createLogger({ level: "error", secrets: [], write: () => {} }),
    handle: async (j) => {
      log.push(`start ${j.alertId}`);
      await tick(j.alertId === "F1" ? 30 : 1);
      log.push(`end ${j.alertId}`);
    },
  });
  q.enqueue(job("F1", "fp"));
  q.enqueue(job("G1", "other"));
  q.enqueue(job("F2", "fp"));
  q.enqueue(job("F3", "fp"));
  await q.idle();
  const pos = (s: string) => log.indexOf(s);
  assert.ok(pos("end F1") < pos("start F2") && pos("end F2") < pos("start F3"));
  assert.ok(pos("end G1") < pos("end F1"), "another fingerprint does not wait behind F1");
  // Same fingerprint on another connector is another key.
  const keys: string[] = [];
  const q2 = createAlertQueue({ slots: createRunSlots(2), maxQueued: 10, logger: createLogger({ level: "error", secrets: [], write: () => {} }), handle: async (j) => { keys.push(j.connectorId); await tick(5); } });
  q2.enqueue(job("X", "fp", "a"));
  q2.enqueue(job("Y", "fp", "b"));
  await tick(1);
  assert.equal(q2.size(), 2);
  await q2.idle();
});

test("a failing job is logged without details and never stops the queue", async () => {
  const lines: string[] = [];
  const done: string[] = [];
  const q = createAlertQueue({
    slots: createRunSlots(1), maxQueued: 10, logger: createLogger({ level: "debug", secrets: ["very-secret-value-123"], write: (l) => void lines.push(l) }),
    handle: async (j) => {
      if (j.alertId === "BAD") throw new Error("boom with very-secret-value-123");
      done.push(j.alertId);
    },
  });
  q.enqueue(job("BAD", "fp"));
  q.enqueue(job("OK1", "fp"));
  q.enqueue(job("OK2", "other"));
  await q.idle();
  assert.deepEqual(done.sort(), ["OK1", "OK2"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /alert_job_failed/);
  assert.doesNotMatch(lines.join("\n"), /very-secret-value-123/);
});

test("capacity counts waiting and running jobs; drain waits or times out", async () => {
  const gate = deferred();
  const q = createAlertQueue({ slots: createRunSlots(1), maxQueued: 3, logger: createLogger({ level: "error", secrets: [], write: () => {} }), handle: () => gate.p });
  assert.equal(q.capacityLeft(), 3);
  q.enqueue(job("1", "a"));
  q.enqueue(job("2", "b"));
  assert.equal(q.size(), 2);
  assert.equal(q.capacityLeft(), 1);
  const started = Date.now();
  await q.drain(20);
  assert.ok(Date.now() - started < 1000, "drain gives up at the timeout");
  assert.equal(q.size(), 2);
  gate.resolve();
  await q.drain(1000);
  assert.equal(q.size(), 0);
  assert.equal(q.capacityLeft(), 3);
  await q.idle();
});

test("a job's follow-up runs after its slot is released, still counts as running and keeps the fingerprint's order", async () => {
  const slots = createRunSlots(1);
  const order: string[] = [];
  const gate = deferred();
  const q = createAlertQueue({
    slots, maxQueued: 10, logger: createLogger({ level: "error", secrets: [], write: () => {} }),
    handle: async (j) => {
      order.push(`run ${j.alertId}`);
      return async () => {
        order.push(`after ${j.alertId}`);
        if (j.alertId === "a1") await gate.p;
        order.push(`done ${j.alertId}`);
      };
    },
  });
  q.enqueue(job("a1", "fp"));
  q.enqueue(job("a2", "fp"));
  q.enqueue(job("b1", "other"));
  await tick(5);
  // One slot only: b1 (another fingerprint) ran while a1's follow-up was still waiting, so the slot was free.
  // a2 shares a1's fingerprint, so it waits for a1's follow-up even though a slot is free.
  assert.deepEqual(order, ["run a1", "after a1", "run b1", "after b1", "done b1"]);
  assert.equal(q.size(), 2, "a1 (follow-up pending) and a2 (waiting) are still counted");
  gate.resolve();
  await q.idle();
  assert.deepEqual(order.slice(5), ["done a1", "run a2", "after a2", "done a2"]);
  assert.equal(slots.inUse(), 0);
});

test("a throwing follow-up is logged and never stops the queue", async () => {
  const slots = createRunSlots(1);
  const logs: string[] = [];
  let ran = 0;
  const q = createAlertQueue({
    slots, maxQueued: 10, logger: createLogger({ level: "error", secrets: [], write: (l) => void logs.push(l) }),
    handle: async () => {
      ran += 1;
      return async () => { throw new Error("boom with details"); };
    },
  });
  q.enqueue(job("a1", "fp"));
  q.enqueue(job("a2", "fp"));
  await q.idle();
  assert.equal(ran, 2);
  assert.ok(logs.some((l) => l.includes("alert_job_failed")));
  assert.ok(!logs.join("\n").includes("boom with details"));
  assert.equal(slots.inUse(), 0);
});
