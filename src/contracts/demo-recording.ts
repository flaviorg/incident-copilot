// Recording replayed by the War Room (spec 5.2 and 10.2).
import * as z from "zod";
import { ScenarioSummarySchema } from "./scenario.ts";
import { TraceEventSchema } from "./trace.ts";
import { AuditEntryViewSchema, IncidentViewSchema } from "./api.ts";
import { ApprovalSchema } from "./approval.ts";
import { IncidentMetricsSchema } from "./metrics.ts";
import { PostmortemDocSchema } from "./postmortem.ts";

export const DEMO_LABEL = "Replay of a recorded run with a scripted fake provider";

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
  recordedWith: z.object({ provider: z.literal("fake"), promptVersions: z.array(z.string()) }), // no appVersion
  scenario: ScenarioSummarySchema,
  common: RecordingBranchSchema, // up to the gate (or to the end, if there is no approval)
  branches: z.object({ approved: RecordingBranchSchema, rejected: RecordingBranchSchema }).nullable(),
});
