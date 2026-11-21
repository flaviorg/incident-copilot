// Test-only notifier (type fake-notifier) that captures every message it is asked to send.
import * as z from "zod";
import { defineNotifier } from "../../src/notifiers/types.ts";
import type { NotificationMessage, NotifierDefinition, NotifyOutcome } from "../../src/notifiers/types.ts";

export const FAKE_NOTIFIER_TYPE = "fake-notifier";

export type FakeNotifier = {
  definition: NotifierDefinition<unknown>;
  messages: NotificationMessage[];
  /** Outcomes to return, in order; once used up, every send succeeds. */
  script: NotifyOutcome[];
  /** While set, every send waits for it (a slow notifier). */
  hold: { promise: Promise<void> | null };
};

export function createFakeNotifier(): FakeNotifier {
  const messages: NotificationMessage[] = [];
  const script: NotifyOutcome[] = [];
  const hold: { promise: Promise<void> | null } = { promise: null };
  const definition = defineNotifier({
    type: FAKE_NOTIFIER_TYPE,
    configSchema: () => z.strictObject({}),
    create: (_c, d) => ({
      id: d.id,
      type: FAKE_NOTIFIER_TYPE,
      send: async (m) => {
        messages.push(structuredClone(m));
        if (hold.promise) await hold.promise;
        return script.shift() ?? { ok: true };
      },
    }),
  });
  return { definition, messages, script, hold };
}
