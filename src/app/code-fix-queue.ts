// In-process queue of code-fix jobs (spec 009, decision 1): its own concurrency (`limits.maxConcurrent`, 1 or 2),
// separate from RunSlots, so an attempt never holds or waits for a graph-run slot. Jobs start in arrival order. A
// failing job is logged with its error name only and never stops the queue.
import type { Logger } from "../infra/logger.ts";

export type CodeFixJob = () => Promise<void>;

export type CodeFixQueue = {
  /** Jobs waiting plus running. */
  size(): number;
  enqueue(job: CodeFixJob): void;
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void>;
};

export function createCodeFixQueue(o: { concurrency: number; logger: Pick<Logger, "error"> }): CodeFixQueue {
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new RangeError(`invalid code-fix concurrency: ${o.concurrency}`);
  const waiting: CodeFixJob[] = [];
  let running = 0;
  let idleWaiters: (() => void)[] = [];

  const size = () => waiting.length + running;
  const settleIdle = () => {
    if (size() > 0) return;
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  };

  const pump = () => {
    while (running < o.concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      running += 1;
      void (async () => {
        try {
          await job();
        } catch (e) {
          o.logger.error("code-fix job failed", { event: "code_fix_job_failed", error: (e as Error)?.name ?? "Error" });
        } finally {
          running -= 1;
          pump();
          settleIdle();
        }
      })();
    }
  };

  return {
    size,
    enqueue(job) {
      waiting.push(job);
      pump();
    },
    idle() {
      if (size() === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
