import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SCHEMA_VERSION } from "../../src/infra/db/schema.ts";
import { SqliteIncidentStore } from "../../src/infra/db/incident-store.ts";
import { DbIds } from "../../src/infra/ids.ts";
import { sha256Hex, constantTimeEqualsText } from "../../src/infra/crypto.ts";
import { canonicalJson } from "../../src/domain/canonical-json.ts";
import {
  IncidentStatusSchema, SeveritySchema, EscalationReasonSchema, ActionStatusSchema, ApprovalStatusSchema,
  TraceTypeSchema, AgentIdSchema, AuditEventSchema, TierSchema,
} from "../../src/contracts/index.ts";

const mk = () => new SqliteIncidentStore(openDatabase(":memory:"), { secrets: ["supersecret-token"], now: () => new Date("2026-10-04T10:00:00Z") });
const entry = (details: Record<string, unknown>) => ({ incidentId: "INC-0001", actor: "system:test", event: "incident_opened" as const, tier: null, details });

/** Lê o CREATE TABLE em sqlite_master e extrai a lista do CHECK (col IN (...)). */
function checkValues(db: DatabaseSync, table: string, column: string): (string | number)[] {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  assert.ok(row, `tabela ${table} inexistente`);
  const m = new RegExp(`\\b${column} IN \\(([^)]*)\\)`).exec(row.sql);
  assert.ok(m, `CHECK de ${table}.${column} não encontrado`);
  return m[1]!.split(",").map((v) => v.trim()).map((v) => (v.startsWith("'") ? v.slice(1, -1) : Number(v)));
}

test("WAL on file databases and foreign keys on", () => {
  const dir = mkdtempSync(join(tmpdir(), "ic-db-"));
  try {
    const db = openDatabase(join(dir, "nested", "ic.db"));
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQL CHECK enums equal the Zod enums", () => {
  const store = mk();
  assert.deepEqual(checkValues(store.db, "incidents", "status"), IncidentStatusSchema.options);
  assert.deepEqual(checkValues(store.db, "incidents", "severity"), SeveritySchema.options);
  assert.deepEqual(checkValues(store.db, "incidents", "escalation_reason"), EscalationReasonSchema.options);
  assert.deepEqual(checkValues(store.db, "actions", "status"), ActionStatusSchema.options);
  assert.deepEqual(checkValues(store.db, "actions", "tier"), TierSchema.options.map((o) => o.value));
  assert.deepEqual(checkValues(store.db, "approvals", "status"), ApprovalStatusSchema.options);
  assert.deepEqual(checkValues(store.db, "trace_events", "type"), TraceTypeSchema.options);
  assert.deepEqual(checkValues(store.db, "trace_events", "agent"), AgentIdSchema.options);
  assert.deepEqual(checkValues(store.db, "audit_log", "event"), AuditEventSchema.options);
});

test("sequential ids from db counters", () => {
  const s = mk(); const ids = new DbIds(s);
  assert.equal(ids.incident(), "INC-0001"); assert.equal(ids.incident(), "INC-0002");
  assert.equal(ids.approval(), "APR-0001"); assert.equal(ids.event("INC-0001", 7), "INC-0001:7");
  assert.equal(ids.action(), "ACT-0001"); assert.equal(ids.run(), "RUN-0001");
});

test("audit rows are chained by hash over canonical JSON", () => {
  const s = mk(); const a = s.appendAudit(entry({ n: 1 })); const b = s.appendAudit(entry({ n: 2 }));
  assert.equal(a.prevHash, "0".repeat(64)); assert.equal(b.prevHash, a.hash);
  assert.equal(a.id, "AUD-0001"); assert.equal(b.id, "AUD-0002");
  for (const r of s.listAudit("INC-0001"))
    assert.equal(r.hash, sha256Hex(r.prevHash + "\n" + canonicalJson({ id: r.id, ts: r.ts, incidentId: r.incidentId, actor: r.actor, event: r.event, tier: r.tier, details: r.details })));
});

test("each incident trail is its own chain, verifiable from genesis even when incidents interleave", () => {
  // Revisão final: a cadeia era global ao banco, e o GET /incidents/:id/audit de um incidente intercalado com outro
  // trazia um prevHash apontando para uma linha alheia, impossível de conferir pelo cliente.
  const s = mk();
  const other = (n: number) => ({ ...entry({ n }), incidentId: "INC-0002" });
  s.appendAudit(entry({ n: 1 }));
  s.appendAudit(other(1));
  s.appendAudit(entry({ n: 2 }));
  s.appendAudit(other(2));
  s.appendAudit(entry({ n: 3 }));
  for (const id of ["INC-0001", "INC-0002"]) {
    const rows = s.listAudit(id);
    assert.equal(rows[0]!.prevHash, "0".repeat(64), id);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.prevHash, rows[i - 1]!.hash, `${id} linha ${i}`);
  }
});

test("details key order does not change the hash", () => {
  assert.equal(mk().appendAudit(entry({ a: 1, b: 2 })).hash, mk().appendAudit(entry({ b: 2, a: 1 })).hash);
});

test("audit_log rejects UPDATE and DELETE", () => {
  const s = mk(); s.appendAudit(entry({}));
  assert.throws(() => s.db.exec("UPDATE audit_log SET actor = 'x'"), /append-only/);
  assert.throws(() => s.db.exec("DELETE FROM audit_log"), /append-only/);
});

test("audit details are redacted", () => assert.equal(mk().appendAudit(entry({ c: "x supersecret-token" })).details.c, "x [REDACTED]"));

test("transaction rolls back on throw", () => {
  const s = mk();
  assert.throws(() => s.transaction(() => { s.nextSequence("incident"); throw new Error("boom"); }));
  assert.equal(s.nextSequence("incident"), 1);
});

test("constant-time comparison over SHA-256", () => {
  assert.equal(constantTimeEqualsText("abc", "abc"), true);
  assert.equal(constantTimeEqualsText("abc", "abcd"), false);
  assert.match(sha256Hex("x"), /^[0-9a-f]{64}$/);
});

test("audit order comes from an explicit INTEGER PRIMARY KEY, not the implicit rowid", () => {
  // Sem INTEGER PRIMARY KEY, o SQLite pode renumerar o rowid num VACUUM; a cadeia de hash depende da ordem.
  const s = mk();
  const cols = s.db.prepare("PRAGMA table_info(audit_log)").all() as { name: string; type: string; pk: number }[];
  assert.deepEqual(cols.filter((c) => c.pk > 0).map((c) => [c.name, c.type]), [["seq", "INTEGER"]]);
  const ddl = (s.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() as { sql: string }).sql;
  assert.match(ddl, /seq INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.equal((s.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
});

// audit_log da versão 1 do schema (sem seq), para o teste de migração.
const V1_AUDIT_DDL = `
CREATE TABLE audit_log (
  id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, incident_id TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL,
  tier INTEGER, details TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX audit_log_incident_idx ON audit_log (incident_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
PRAGMA user_version = 1;`;

test("a version 1 database is migrated keeping the audit order, the chain and the append-only triggers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ic-db-"));
  try {
    const path = join(dir, "v1.db");
    const old = new DatabaseSync(path);
    old.exec(V1_AUDIT_DDL);
    // ids fora de ordem lexicográfica de propósito: a ordem é a de inserção.
    let prev = "0".repeat(64);
    for (const [i, id] of ["AUD-9999", "AUD-10000", "AUD-10001"].entries()) {
      const body = { id, ts: `2026-10-04T10:00:0${i}.000Z`, incidentId: "INC-0001", actor: "system:test", event: "incident_opened", tier: null, details: { i } };
      const hash = sha256Hex(prev + "\n" + canonicalJson(body));
      old.prepare("INSERT INTO audit_log (id, ts, incident_id, actor, event, tier, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, body.ts, body.incidentId, body.actor, body.event, null, JSON.stringify(body.details), prev, hash);
      prev = hash;
    }
    old.close();

    const s = new SqliteIncidentStore(openDatabase(path), { secrets: [], now: () => new Date("2026-10-04T10:01:00Z") });
    assert.equal((s.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    const rows = s.listAudit("INC-0001");
    assert.deepEqual(rows.map((r) => r.id), ["AUD-9999", "AUD-10000", "AUD-10001"]);
    assert.equal(rows[0]!.prevHash, "0".repeat(64));
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.prevHash, rows[i - 1]!.hash);
    assert.equal(s.appendAudit(entry({ depois: true })).prevHash, prev, "a próxima linha continua a cadeia migrada");
    assert.throws(() => s.db.exec("UPDATE audit_log SET actor = 'x'"), /append-only/);
    assert.throws(() => s.db.exec("DELETE FROM audit_log"), /append-only/);
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
