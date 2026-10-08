// Gravação reproduzida pela War Room (spec 5.2 e 10.2).
import * as z from "zod";
import { ScenarioSummarySchema } from "./scenario.ts";
import { TraceEventSchema } from "./trace.ts";
import { AuditEntryViewSchema, IncidentViewSchema } from "./api.ts";
import { ApprovalSchema } from "./approval.ts";
import { IncidentMetricsSchema } from "./metrics.ts";
import { PostmortemDocSchema } from "./postmortem.ts";

export const DEMO_LABEL = "Reprodução de execução gravada com provedor fake roteirizado";

export const RecordingBranchSchema = z.object({
  events: z.array(TraceEventSchema),
  incident: IncidentViewSchema,
  approvals: z.array(ApprovalSchema),
  audit: z.array(AuditEntryViewSchema),
  metrics: IncidentMetricsSchema.nullable(),
  postmortem: PostmortemDocSchema.nullable(),
});

export const DemoRecordingSchema = z.object({
  schemaVersion: z.literal(1),
  label: z.literal(DEMO_LABEL),
  recordedWith: z.object({ provider: z.literal("fake"), promptVersions: z.array(z.string()) }), // sem appVersion
  scenario: ScenarioSummarySchema,
  common: RecordingBranchSchema, // até o portão (ou até o fim, se não houver aprovação)
  branches: z.object({ approved: RecordingBranchSchema, rejected: RecordingBranchSchema }).nullable(),
});
