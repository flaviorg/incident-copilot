// SQL do banco. Os CHECK de enum são gerados dos schemas Zod, para os dois nunca divergirem (AC-40).
import type { DatabaseSync } from "node:sqlite";
import {
  ActionStatusSchema, AgentIdSchema, ApprovalStatusSchema, AuditEventSchema, EscalationReasonSchema,
  IncidentStatusSchema, LlmErrorKindSchema, SeveritySchema, TierSchema, TraceTypeSchema,
} from "../../contracts/index.ts";

export const SCHEMA_VERSION = 2;

const quoted = (values: readonly string[]) => values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ");
const tiers = TierSchema.options.map((o) => o.value).join(", ");

/**
 * A ordem da cadeia de hash vem de `seq` (INTEGER PRIMARY KEY AUTOINCREMENT): o rowid implícito de uma tabela sem
 * chave inteira pode ser renumerado num VACUUM, e o id AUD-#### não ordena depois de 9999.
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

function buildSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
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
);
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

CREATE TABLE IF NOT EXISTS actions (
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
);
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
  ts TEXT NOT NULL
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
`;
}

const AUDIT_COLUMNS = "id, ts, incident_id, actor, event, tier, details, prev_hash, hash";

/**
 * Versão 1 → 2: a audit_log ganha `seq`. A tabela é reconstruída numa transação, copiando as linhas na ordem do rowid
 * (a única que a versão 1 tinha); o DROP TABLE não dispara os gatilhos de DELETE, e os gatilhos e o índice voltam
 * pelo buildSchemaSql.
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

export function migrate(db: DatabaseSync): void {
  addAuditSeq(db);
  db.exec(buildSchemaSql());
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
