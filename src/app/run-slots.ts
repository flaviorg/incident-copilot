// Graph-run slots shared by POST /incidents and the live alert queue (spec 008, AC-48): at most MAX_CONCURRENT_RUNS
// runs at a time in the process. HTTP takes a slot or answers 429; the queue waits for one, first come first served.

export type RunSlots = {
  /** A release function, or null when every slot is taken. */
  tryAcquire(): (() => void) | null;
  /** Waits for a slot (FIFO). */
  acquire(): Promise<() => void>;
  inUse(): number;
};

export function createRunSlots(capacity: number): RunSlots {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`invalid run slot capacity: ${capacity}`);
  let used = 0;
  const waiters: ((release: () => void) => void)[] = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next(makeRelease()); // the slot passes straight to the next waiter
      else used -= 1;
    };
  };

  return {
    tryAcquire() {
      if (used >= capacity) return null;
      used += 1;
      return makeRelease();
    },
    acquire() {
      if (used < capacity) {
        used += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    inUse: () => used,
  };
}
