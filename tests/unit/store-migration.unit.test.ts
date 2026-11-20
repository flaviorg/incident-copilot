// Schema version 3 → 4 (spec 008): the CHECK lists of incidents, actions and audit_log gain the new enum values by a
// table rebuild that keeps the rows, seq, the hash chain and the append-only triggers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SCHEMA_VERSION } from "../../src/infra/db/schema.ts";
import { SqliteIncidentStore } from "../../src/infra/db/incident-store.ts";
import { sha256Hex } from "../../src/infra/crypto.ts";
import { canonicalJson } from "../../src/domain/canonical-json.ts";
import type { AuditEntry } from "../../src/contracts/index.ts";

const V3_SQL = readFileSync("tests/fixtures/db/schema-v3.sql", "utf8");
const TS = "2026-10-04T09:00:00.000Z";

function withTempDb(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ic-mig-"));
  try {
    fn(join(dir, "ic.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A version 3 file database with one incident, one action, a blackboard and three chained audit rows. */
function seedV3(path: string): { lastHash: string; maxSeq: number } {
  const db = new DatabaseSync(path);
  db.exec(V3_SQL);
  db.exec("PRAGMA user_version = 3");
  db.prepare(
    `INSERT INTO incidents (id, title, service, severity, status, scenario_id, opened_at, impact_started_at, detected_at, resolved_at, escalation_reason, escalation_detail, mttr_min)
     VALUES ('INC-0001', 'old incident', 'orders-api', 'sev1', 'resolved', 'deploy-5xx-rollback', ?, ?, ?, ?, NULL, NULL, 11.5)`,
  ).run(TS, TS, TS, TS);
  db.prepare("INSERT INTO blackboards (incident_id, json, version) VALUES ('INC-0001', '{\"x\":1}', 3)").run();
  db.prepare(
    `INSERT INTO actions (id, incident_id, ord, action_type, target, tier, status, executed_at, created_at, json)
     VALUES ('ACT-0001', 'INC-0001', 1, 'rollback_deployment', 'deployment/orders-api', 3, 'succeeded', ?, ?, '{}')`,
  ).run(TS, TS);
  let prev = "0".repeat(64);
  for (let i = 1; i <= 3; i++) {
    const body = { id: `AUD-000${i}`, ts: TS, incidentId: "INC-0001", actor: "system:test", event: "incident_opened", tier: null, details: { n: i } };
    const hash = sha256Hex(prev + "\n" + canonicalJson(body));
    db.prepare("INSERT INTO audit_log (id, ts, incident_id, actor, event, tier, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(body.id, body.ts, body.incidentId, body.actor, body.event, null, JSON.stringify(body.details), prev, hash);
    prev = hash;
  }
  db.prepare("INSERT INTO sequences (name, value) VALUES ('audit', 3)").run();
  const maxSeq = Number((db.prepare("SELECT MAX(seq) AS m FROM audit_log").get() as { m: number }).m);
  db.close();
  return { lastHash: prev, maxSeq };
}

const verifyChain = (rows: AuditEntry[]) => {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    assert.equal(r.prevHash, i === 0 ? "0".repeat(64) : rows[i - 1]!.hash);
    assert.equal(r.hash, sha256Hex(r.prevHash + "\n" + canonicalJson({ id: r.id, ts: r.ts, incidentId: r.incidentId, actor: r.actor, event: r.event, tier: r.tier, details: r.details })));
  }
};

test("a version 3 database migrates to version 4 keeping rows, seq, chain and triggers", () => {
  withTempDb((path) => {
    const { lastHash, maxSeq } = seedV3(path);
    const db = openDatabase(path);
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 4);
    assert.equal(Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys), 1);
    const store = new SqliteIncidentStore(db, { secrets: [], now: () => new Date("2026-10-04T10:00:00Z") });

    // Rows intact.
    const inc = store.getIncident("INC-0001")!;
    assert.deepEqual([inc.title, inc.status, inc.resolvedAt], ["old incident", "resolved", TS]);
    assert.equal((db.prepare("SELECT mttr_min FROM incidents WHERE id = 'INC-0001'").get() as { mttr_min: number }).mttr_min, 11.5);
    assert.deepEqual(db.prepare("SELECT json, version FROM blackboards").all().map((r) => ({ ...r })), [{ json: "{\"x\":1}", version: 3 }]);
    assert.deepEqual(db.prepare("SELECT id, status, tier FROM actions").all().map((r) => ({ ...r })), [{ id: "ACT-0001", status: "succeeded", tier: 3 }]);

    // Chain and seq.
    const rows = store.listAudit("INC-0001");
    assert.equal(rows.length, 3);
    assert.equal(rows.at(-1)!.hash, lastHash);
    verifyChain(rows);
    const next = store.appendAudit({ incidentId: "INC-0001", actor: "system:test", event: "alert_ingested", tier: null, details: { after: true } });
    assert.equal(next.prevHash, lastHash);
    const seqs = (db.prepare("SELECT seq FROM audit_log ORDER BY seq").all() as { seq: number }[]).map((r) => Number(r.seq));
    assert.ok(seqs.at(-1)! > maxSeq);
    verifyChain(store.listAudit("INC-0001"));

    // Append-only triggers came back.
    assert.throws(() => db.exec("UPDATE audit_log SET actor = 'x'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM audit_log"), /append-only/);

    // New enum values are accepted.
    store.updateIncidentStatus("INC-0001", "advised", {});
    assert.equal(store.getIncident("INC-0001")!.status, "advised");
    db.prepare("UPDATE actions SET status = 'recommended' WHERE id = 'ACT-0001'").run();
    // Indexes are back.
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    for (const i of ["incidents_opened_idx", "actions_incident_idx", "audit_log_incident_idx", "live_incidents_open_idx"]) assert.ok(indexes.includes(i), i);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_v4'").get() as { n: number }).n, 0);
    db.close();

    // Reopening is a no-op.
    const before = readFileSync(path).length;
    const again = openDatabase(path);
    const sqlBefore = again.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((r) => ({ ...r }));
    assert.equal(new SqliteIncidentStore(again, { secrets: [], now: () => new Date() }).listAudit("INC-0001").length, 4);
    again.close();
    const third = openDatabase(path);
    assert.deepEqual(third.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((r) => ({ ...r })), sqlBefore);
    third.close();
    assert.ok(before > 0);
  });
});

test("a fresh database is created at version 4 without a rebuild", () => {
  const db = openDatabase(":memory:");
  assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 4);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes("ingested_alerts") && tables.includes("live_incidents"));
  db.close();
});
