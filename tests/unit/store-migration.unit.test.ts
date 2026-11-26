// Schema version 4 → 5 (spec 009): trace_events joins the rebuilt tables and the code-fix tables appear.
// Schema version 3 → 4 (spec 008): the CHECK lists of incidents, actions and audit_log gain the new enum values by a
// table rebuild that keeps the rows, seq, the hash chain and the append-only triggers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SCHEMA_VERSION, buildSchemaSql } from "../../src/infra/db/schema.ts";
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

test("a version 3 database migrates to version 5 keeping rows, seq, chain and triggers", () => {
  withTempDb((path) => {
    const { lastHash, maxSeq } = seedV3(path);
    const db = openDatabase(path);
    assert.equal(SCHEMA_VERSION, 5);
    assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 5);
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
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%\\_v_' ESCAPE '\\'").get() as { n: number }).n, 0);
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

test("a fresh database is created at version 5 without a rebuild", () => {
  const db = openDatabase(":memory:");
  assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 5);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes("ingested_alerts") && tables.includes("live_incidents"));
  assert.ok(tables.includes("code_fix_attempts") && tables.includes("code_fix_approvals"));
  db.close();
});

/**
 * The version 4 SQL: today's schema with the spec 009 literals taken out of every CHECK and without the code-fix tables,
 * which is what a 0.4 database stores.
 */
function v4Sql(): string {
  return buildSchemaSql().replace(/, 'code_fix[a-z_]*'|'code_fix[a-z_]*', /g, "");
}

function seedV4(path: string): { lastHash: string; maxSeq: number } {
  const db = new DatabaseSync(path);
  db.exec(v4Sql());
  db.exec("DROP TABLE IF EXISTS code_fix_attempts; DROP TABLE IF EXISTS code_fix_approvals;");
  db.exec("PRAGMA user_version = 4");
  const traceSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trace_events'").get() as { sql: string }).sql;
  assert.ok(!traceSql.includes("'code_fixer'"));
  db.prepare(
    `INSERT INTO incidents (id, title, service, severity, status, scenario_id, opened_at, impact_started_at, detected_at, resolved_at, escalation_reason, escalation_detail, mttr_min)
     VALUES ('INC-0001', 'live incident', 'checkout-web', 'sev2', 'advised', 'live', ?, ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(TS, TS, TS);
  for (let seq = 1; seq <= 2; seq++) {
    const ev = { id: `INC-0001:${seq}`, incidentId: "INC-0001", runId: "RUN-0001", requestId: null, seq, ts: TS, agent: "supervisor", llm: null, type: "thought", payload: { text: `t${seq}` } };
    db.prepare("INSERT INTO trace_events (id, incident_id, run_id, request_id, seq, ts, agent, type, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ev.id, ev.incidentId, ev.runId, null, seq, TS, ev.agent, ev.type, JSON.stringify(ev));
  }
  let prev = "0".repeat(64);
  for (let i = 1; i <= 3; i++) {
    const body = { id: `AUD-000${i}`, ts: TS, incidentId: "INC-0001", actor: "system:test", event: "alert_ingested", tier: null, details: { n: i } };
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

test("a version 4 database migrates to version 5: trace_events accepts code_fixer and the code-fix tables exist", () => {
  withTempDb((path) => {
    const { lastHash, maxSeq } = seedV4(path);
    const db = openDatabase(path);
    assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 5);
    const store = new SqliteIncidentStore(db, { secrets: [], now: () => new Date("2026-10-04T10:00:00Z") });

    // Audit chain and seq preserved.
    const rows = store.listAudit("INC-0001");
    assert.equal(rows.length, 3);
    assert.equal(rows.at(-1)!.hash, lastHash);
    verifyChain(rows);
    assert.equal(Number((db.prepare("SELECT MAX(seq) AS m FROM audit_log").get() as { m: number }).m), maxSeq);
    const next = store.appendAudit({ incidentId: "INC-0001", actor: "agent:code_fixer", event: "code_fix_skipped", tier: null, details: { reason: "not_advised" } });
    assert.equal(next.prevHash, lastHash);
    verifyChain(store.listAudit("INC-0001"));
    assert.throws(() => db.exec("DELETE FROM audit_log"), /append-only/);

    // Trace rows kept, (incident_id, seq) still unique, the new agent accepted.
    assert.deepEqual(store.listTrace("INC-0001").map((e) => e.seq), [1, 2]);
    store.appendTrace([{
      id: "INC-0001:3", incidentId: "INC-0001", runId: "fix_abc12345", requestId: null, seq: 3, ts: TS, agent: "code_fixer", llm: null,
      type: "observation", payload: { tool: "fix_locate", ok: true, summary: "anchor found", evidenceRef: null },
    }]);
    assert.equal(store.listTrace("INC-0001").at(-1)!.agent, "code_fixer");
    assert.throws(() => db.prepare("INSERT INTO trace_events (id, incident_id, run_id, request_id, seq, ts, agent, type, json) VALUES ('dup', 'INC-0001', 'R', NULL, 3, ?, 'code_fixer', 'thought', '{}')").run(TS), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO trace_events (id, incident_id, run_id, request_id, seq, ts, agent, type, json) VALUES ('bad', 'INC-0001', 'R', NULL, 9, ?, 'nobody', 'thought', '{}')").run(TS), /CHECK/);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    for (const i of ["trace_events_ts_idx", "code_fix_attempts_key_idx", "code_fix_attempts_incident_idx"]) assert.ok(indexes.includes(i), i);

    // Code-fix tables and the partial unique key.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(tables.includes("code_fix_attempts") && tables.includes("code_fix_approvals"));
    const insert = db.prepare(
      `INSERT INTO code_fix_attempts (id, incident_id, repo, error_group_id, status, key_held, created_at, finished_at, version, json)
       VALUES (?, 'INC-0001', 'acme/checkout-web', '12345', ?, ?, ?, NULL, 0, '{}')`,
    );
    insert.run("fix_skip00001", "skipped", 0, TS);
    insert.run("fix_skip00002", "gave_up", 0, TS);
    insert.run("fix_held00001", "running", 1, TS);
    assert.throws(() => insert.run("fix_held00002", "running", 1, TS), /UNIQUE/);
    assert.throws(() => insert.run("fix_bad000001", "nope", 0, TS), /CHECK/);
    assert.throws(() => insert.run("fix_bad000002", "running", 2, TS), /CHECK/);
    assert.throws(
      () => db.prepare(`INSERT INTO code_fix_attempts (id, incident_id, repo, error_group_id, status, key_held, created_at, finished_at, version, json)
        VALUES ('fix_orphan001', 'INC-9999', 'acme/x', '1', 'skipped', 0, ?, NULL, 0, '{}')`).run(TS),
      /FOREIGN KEY/,
    );
    const approval = db.prepare(
      `INSERT INTO code_fix_approvals (id, incident_id, action_id, attempt_id, status, requested_at, expires_at, decided_at, version, json)
       VALUES (?, 'INC-0001', 'fix_held00001', 'fix_held00001', ?, ?, ?, NULL, 0, '{}')`,
    );
    approval.run("APR-FIX-0001", "pending", TS, TS);
    assert.throws(() => approval.run("APR-FIX-0002", "maybe", TS, TS), /CHECK/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%\\_v_' ESCAPE '\\'").get() as { n: number }).n, 0);
    db.close();

    // Reopening is a no-op.
    const again = openDatabase(path);
    const sqlBefore = again.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((r) => ({ ...r }));
    again.close();
    const third = openDatabase(path);
    assert.deepEqual(third.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((r) => ({ ...r })), sqlBefore);
    third.close();
  });
});
