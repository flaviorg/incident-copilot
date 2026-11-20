// Database SQL. The enum CHECKs are generated from the Zod schemas, so the two never diverge (AC-40).
import type { DatabaseSync } from "node:sqlite";
import {
  ActionStatusSchema, AgentIdSchema, ApprovalStatusSchema, AuditEventSchema, EscalationReasonSchema,
  IncidentStatusSchema, IngestOutcomeSchema, LlmErrorKindSchema, SeveritySchema, TierSchema, TraceTypeSchema,
} from "../../contracts/index.ts";

export const SCHEMA_VERSION = 4;

const quoted = (values: readonly string[]) => values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ");
const tiers = TierSchema.options.map((o) => o.value).join(", ");

/**
 * The hash chain order comes from `seq` (INTEGER PRIMARY KEY AUTOINCREMENT): the implicit rowid of a table without
 * an integer key can be renumbered on a VACUUM, and the AUD-#### id does not sort after 9999.
 */
function auditLogTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (${quoted(AuditEventSchema.options)})),
  tier INTEGER CHECK (tier IS NULL OR tier IN (${tiers})),
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);`;
}

function incidentsTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  service TEXT,
  severity TEXT NOT NULL CHECK (severity IN (${quoted(SeveritySchema.options)})),
  status TEXT NOT NULL CHECK (status IN (${quoted(IncidentStatusSchema.options)})),
  scenario_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  impact_started_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  escalation_reason TEXT CHECK (escalation_reason IS NULL OR escalation_reason IN (${quoted(EscalationReasonSchema.options)})),
  escalation_detail TEXT,
  mttr_min REAL
);`;
}

function actionsTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  ord INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  target TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (${tiers})),
  status TEXT NOT NULL CHECK (status IN (${quoted(ActionStatusSchema.options)})),
  executed_at TEXT,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);`;
}

export function buildSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

${incidentsTableSql("incidents")}
CREATE INDEX IF NOT EXISTS incidents_opened_idx ON incidents (opened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status);
CREATE INDEX IF NOT EXISTS incidents_service_idx ON incidents (service);

CREATE TABLE IF NOT EXISTS blackboards (
  incident_id TEXT PRIMARY KEY REFERENCES incidents (id),
  json TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  run_id TEXT NOT NULL,
  request_id TEXT,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN (${quoted(AgentIdSchema.options)})),
  type TEXT NOT NULL CHECK (type IN (${quoted(TraceTypeSchema.options)})),
  json TEXT NOT NULL,
  UNIQUE (incident_id, seq)
);
CREATE INDEX IF NOT EXISTS trace_events_ts_idx ON trace_events (ts);

${actionsTableSql("actions")}
CREATE INDEX IF NOT EXISTS actions_incident_idx ON actions (incident_id, ord);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  action_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${quoted(ApprovalStatusSchema.options)})),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  version INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_incident_idx ON approvals (incident_id);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status);

-- Só inserção: sem chave estrangeira (a auditoria não pode falhar por ordem de gravação) e com gatilhos contra UPDATE e DELETE.
${auditLogTableSql("audit_log")}
CREATE INDEX IF NOT EXISTS audit_log_incident_idx ON audit_log (incident_id);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  error_kind TEXT CHECK (error_kind IS NULL OR error_kind IN (${quoted(LlmErrorKindSchema.options)})),
  ts TEXT NOT NULL,
  ${LLM_CALL_EXTRA_COLUMNS.map((c) => c.sql).join(",\n  ")}
);
CREATE INDEX IF NOT EXISTS llm_calls_incident_idx ON llm_calls (incident_id);
CREATE INDEX IF NOT EXISTS llm_calls_ts_idx ON llm_calls (ts);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS runs_incident_idx ON runs (incident_id);

-- Version 4 (spec 008): alerts received by webhook and the live incident each fingerprint has open.
CREATE TABLE IF NOT EXISTS ingested_alerts (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
  received_at TEXT NOT NULL,
  request_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (${quoted(IngestOutcomeSchema.options)})),
  incident_id TEXT,
  detail TEXT,
  json TEXT NOT NULL,
  UNIQUE (connector_id, external_id)
);
CREATE INDEX IF NOT EXISTS ingested_alerts_fingerprint_idx ON ingested_alerts (connector_id, fingerprint, received_at);
CREATE INDEX IF NOT EXISTS ingested_alerts_received_idx ON ingested_alerts (received_at DESC);

CREATE TABLE IF NOT EXISTS live_incidents (
  incident_id TEXT PRIMARY KEY REFERENCES incidents (id),
  connector_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS live_incidents_open_idx ON live_incidents (connector_id, fingerprint) WHERE closed_at IS NULL;
`;
}

/** Added in version 3 (review 2026-11): attempts behind a logical call, fallback used, usage estimated. */
const LLM_CALL_EXTRA_COLUMNS = [
  { name: "attempts", sql: "attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1)" },
  { name: "used_fallback", sql: "used_fallback INTEGER NOT NULL DEFAULT 0 CHECK (used_fallback IN (0, 1))" },
  { name: "usage_estimated", sql: "usage_estimated INTEGER NOT NULL DEFAULT 0 CHECK (usage_estimated IN (0, 1))" },
];

/** Version 2 → 3: llm_calls gains the extra columns (old rows get the defaults). */
function addLlmCallColumns(db: DatabaseSync): void {
  const cols = new Set((db.prepare("PRAGMA table_info(llm_calls)").all() as { name: string }[]).map((c) => c.name));
  for (const c of LLM_CALL_EXTRA_COLUMNS) if (!cols.has(c.name)) db.exec(`ALTER TABLE llm_calls ADD COLUMN ${c.sql}`);
}

const AUDIT_COLUMNS = "id, ts, incident_id, actor, event, tier, details, prev_hash, hash";

/**
 * Version 1 → 2: audit_log gains `seq`. The table is rebuilt in a transaction, copying the rows in rowid order
 * (the only order version 1 had); DROP TABLE does not fire the DELETE triggers, and the triggers and the index come back
 * through buildSchemaSql.
 */
function addAuditSeq(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[];
  if (cols.length === 0 || cols.some((c) => c.name === "seq")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(auditLogTableSql("audit_log_v2"));
    db.exec(`INSERT INTO audit_log_v2 (${AUDIT_COLUMNS}) SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY rowid`);
    db.exec("DROP TABLE audit_log");
    db.exec("ALTER TABLE audit_log_v2 RENAME TO audit_log");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Tables whose CHECK lists come from enums that grow, with the SQL builder and the enums each CHECK uses. */
const ENUM_CHECKED_TABLES: readonly { name: string; sql: (name: string) => string; enums: readonly (readonly string[])[]; orderBy: string | null }[] = [
  { name: "incidents", sql: incidentsTableSql, enums: [IncidentStatusSchema.options, SeveritySchema.options, EscalationReasonSchema.options], orderBy: null },
  { name: "actions", sql: actionsTableSql, enums: [ActionStatusSchema.options], orderBy: null },
  { name: "audit_log", sql: auditLogTableSql, enums: [AuditEventSchema.options], orderBy: "seq" },
];

const columnsOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Version 3 → 4: a CHECK constraint cannot be altered, so a table whose stored SQL lacks any current enum literal is
 * rebuilt following https://www.sqlite.org/lang_altertable.html#otheralter: foreign keys off (outside the transaction),
 * create <name>_v4 with the current SQL, copy the common columns (audit_log in seq order, keeping seq and so the hash chain),
 * drop the old table, rename, check foreign keys, commit. DROP TABLE does not fire the DELETE triggers; indexes and the
 * append-only triggers come back through buildSchemaSql.
 */
export function rebuildStaleCheckTables(db: DatabaseSync): void {
  const stale = ENUM_CHECKED_TABLES.filter((t) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t.name) as { sql: string } | undefined;
    if (!row) return false;
    return t.enums.some((values) => values.some((v) => !row.sql.includes(`'${v.replaceAll("'", "''")}'`)));
  });
  if (stale.length === 0) return;
  const fkWasOn = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys) === 1;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of stale) {
        const tmp = `${t.name}_v4`;
        db.exec(`DROP TABLE IF EXISTS ${tmp}`);
        db.exec(t.sql(tmp));
        const target = columnsOf(db, tmp);
        const common = columnsOf(db, t.name).filter((c) => target.includes(c));
        const cols = common.join(", ");
        db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${t.name}${t.orderBy ? ` ORDER BY ${t.orderBy}` : ""}`);
        db.exec(`DROP TABLE ${t.name}`);
        db.exec(`ALTER TABLE ${tmp} RENAME TO ${t.name}`);
      }
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error(`schema migration to version ${SCHEMA_VERSION} found ${violations.length} foreign key violation(s)`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
  }
}

export function migrate(db: DatabaseSync): void {
  addAuditSeq(db);
  rebuildStaleCheckTables(db);
  db.exec(buildSchemaSql());
  addLlmCallColumns(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
