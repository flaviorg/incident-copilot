import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/infra/logger.ts";

const S = ["abcdefghijklmnop"];
test("writes one redacted JSON line per event and respects the level", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "info", secrets: S, write: (l) => lines.push(l), now: () => new Date("2026-10-04T10:00:00Z") });
  log.debug("hidden"); log.child({ requestId: "r1" }).info("hello abcdefghijklmnop", { incidentId: "INC-0001" });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { ts: "2026-10-04T10:00:00.000Z", level: "info", msg: "hello [REDACTED]", requestId: "r1", incidentId: "INC-0001" });
});
