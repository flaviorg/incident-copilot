// In-process queue of live alert jobs (spec 008, decision 9; AC-48 and AC-55). Jobs of one connector + fingerprint run
// strictly in arrival order, one at a time, so a resolve never overtakes the run that opened the incident; different
// fingerprints run in parallel up to the shared run slots. A failing job is logged and never stops the queue. A job may
// return a follow-up (its notifications): it runs after the slot is released, so a slow notifier never holds a run slot,
// but the job still counts as running and keeps its fingerprint's order until the follow-up is done.
import type { Logger } from "../infra/logger.ts";
import type { RunSlots } from "./run-slots.ts";

export type AlertJob = { alertId: string; connectorId: string; fingerprint: string };

/** What a handler may return: work to do once the run slot is free. */
export type JobFollowUp = () => Promise<void>;

export type AlertQueue = {
  /** Jobs waiting plus running. */
  size(): number;
  capacityLeft(): number;
  enqueue(job: AlertJob): void;
  /** Resolves when nothing is queued or running, or after `timeoutMs`. */
  drain(timeoutMs?: number): Promise<void>;
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void>;
};

const keyOf = (j: AlertJob) => `${j.connectorId}\u0000${j.fingerprint}`;

export function createAlertQueue(o: { slots: RunSlots; maxQueued: number; logger: Logger; handle(job: AlertJob): Promise<void | JobFollowUp> }): AlertQueue {
  const waiting: AlertJob[] = [];
  const activeKeys = new Set<string>();
  let running = 0;
  let dispatching = false;
  let idleWaiters: (() => void)[] = [];

  const size = () => waiting.length + running;
  const settleIdle = () => {
    if (size() > 0) return;
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  };

  const runJob = async (job: AlertJob, release: () => void) => {
    const failed = (e: unknown) =>
      o.logger.error("alert job failed", { event: "alert_job_failed", alertId: job.alertId, connectorId: job.connectorId, error: (e as Error)?.name ?? "Error" });
    let followUp: void | JobFollowUp = undefined;
    try {
      followUp = await o.handle(job);
    } catch (e) {
      failed(e);
    }
    release();
    try {
      if (followUp) await followUp();
    } catch (e) {
      failed(e);
    } finally {
      running -= 1;
      activeKeys.delete(keyOf(job));
      void dispatch();
      settleIdle();
    }
  };

  /** Starts, in arrival order, every waiting job whose key is not running, each once it holds a slot. */
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      for (;;) {
        const i = waiting.findIndex((j) => !activeKeys.has(keyOf(j)));
        if (i < 0) break;
        const job = waiting.splice(i, 1)[0]!;
        activeKeys.add(keyOf(job));
        running += 1;
        const release = await o.slots.acquire();
        void runJob(job, release);
      }
    } finally {
      dispatching = false;
    }
  };

  return {
    size,
    capacityLeft: () => Math.max(0, o.maxQueued - size()),
    enqueue(job) {
      waiting.push(job);
      void dispatch();
    },
    idle() {
      if (size() === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    async drain(timeoutMs) {
      if (timeoutMs === undefined) return this.idle();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.idle(), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
      clearTimeout(timer);
    },
  };
}
