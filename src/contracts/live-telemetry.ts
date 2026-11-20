// Normalized telemetry records returned by connector query capabilities (spec 008, decision 2). Every vendor maps to
// these shapes, so one pure formatter writes the observation. Nullable fields are null when the vendor lacks them.
import * as z from "zod";

const iso = z.iso.datetime();

export const ErrorGroupSchema = z.object({
  id: z.string().max(200),
  title: z.string().max(300),
  culprit: z.string().max(300).nullable(),
  level: z.string().max(40).nullable(),
  status: z.string().max(40).nullable(),
  count: z.number().int().nonnegative().nullable(),
  userCount: z.number().int().nonnegative().nullable(),
  firstSeen: iso.nullable(),
  lastSeen: iso.nullable(),
  release: z.string().max(120).nullable(),
  url: z.string().max(2000).nullable(),
});

export const MetricSeriesSchema = z.object({
  metric: z.string().max(64),
  unit: z.string().max(32).nullable(),
  points: z.array(z.object({ ts: iso, value: z.number() })).max(500),
});

export const LogEntrySchema = z.object({
  ts: iso,
  level: z.enum(["ERROR", "WARN", "INFO"]),
  message: z.string().max(500),
  count: z.number().int().min(1),
});

export const DeployRecordSchema = z.object({
  version: z.string().max(120),
  at: iso,
  environment: z.string().max(120).nullable(),
  author: z.string().max(120).nullable(),
  description: z.string().max(300).nullable(),
  url: z.string().max(2000).nullable(),
});

export const ExternalToolInfoSchema = z.object({
  name: z.string().max(128),
  description: z.string().max(1000),
  inputSchema: z.unknown(),
});

export const ExternalResultSchema = z.object({
  ok: z.boolean(),
  text: z.string().max(8000),
});
