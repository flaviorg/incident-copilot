CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  service TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3')),
  status TEXT NOT NULL CHECK (status IN ('open', 'investigating', 'awaiting_approval', 'mitigating', 'resolved', 'escalated')),
  scenario_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  impact_started_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  escalation_reason TEXT CHECK (escalation_reason IS NULL OR escalation_reason IN ('team_cap_reached', 'react_cap_low_confidence', 'low_confidence_diagnosis', 'recursion_limit', 'llm_unavailable', 'timeout', 'mitigation_rejected', 'remediation_ineffective', 'throttled', 'circuit_open', 'no_executable_actions')),
  escalation_detail TEXT,
  mttr_min REAL
);

CREATE INDEX incidents_opened_idx ON incidents (opened_at DESC, id DESC);

CREATE INDEX incidents_status_idx ON incidents (status);

CREATE INDEX incidents_service_idx ON incidents (service);

CREATE TABLE blackboards (
  incident_id TEXT PRIMARY KEY REFERENCES incidents (id),
  json TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE trace_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  run_id TEXT NOT NULL,
  request_id TEXT,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('supervisor', 'telemetry_analyst', 'runbook_retriever', 'remediation_planner', 'auditor', 'gate', 'executor', 'verifier', 'reporter', 'human', 'system', 'mcp_client')),
  type TEXT NOT NULL CHECK (type IN ('thought', 'action', 'observation', 'plan', 'critique', 'answer', 'handoff')),
  json TEXT NOT NULL,
  UNIQUE (incident_id, seq)
);

CREATE INDEX trace_events_ts_idx ON trace_events (ts);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  ord INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  target TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3, 4)),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'blocked_forbidden', 'blocked_unknown', 'rejected_invalid_params', 'rejected_by_dry_run', 'awaiting_approval', 'approved', 'rejected', 'expired', 'ready', 'succeeded', 'failed', 'throttled', 'blocked_circuit_open', 'cancelled', 'reverted')),
  executed_at TEXT,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE INDEX actions_incident_idx ON actions (incident_id, ord);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  action_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  version INTEGER NOT NULL,
  json TEXT NOT NULL
);

CREATE INDEX approvals_incident_idx ON approvals (incident_id);

CREATE INDEX approvals_status_idx ON approvals (status);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('incident_opened', 'action_blocked_forbidden', 'action_blocked_unknown', 'action_rejected_invalid_params', 'action_dry_run_failed', 'action_ready', 'action_executed', 'action_failed', 'action_throttled', 'action_blocked_circuit_open', 'action_cancelled', 'approval_requested', 'approval_approved', 'approval_rejected', 'approval_expired', 'approval_auth_failed', 'canary_rollback', 'circuit_opened', 'incident_escalated', 'incident_resolved')),
  tier INTEGER CHECK (tier IS NULL OR tier IN (1, 2, 3, 4)),
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX audit_log_incident_idx ON audit_log (incident_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE llm_calls (
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
  error_kind TEXT CHECK (error_kind IS NULL OR error_kind IN ('timeout', 'rate_limit', 'server_error', 'invalid_output', 'aborted')),
  ts TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  used_fallback INTEGER NOT NULL DEFAULT 0 CHECK (used_fallback IN (0, 1)),
  usage_estimated INTEGER NOT NULL DEFAULT 0 CHECK (usage_estimated IN (0, 1))
);

CREATE INDEX llm_calls_incident_idx ON llm_calls (incident_id);

CREATE INDEX llm_calls_ts_idx ON llm_calls (ts);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT
);

CREATE INDEX runs_incident_idx ON runs (incident_id);
