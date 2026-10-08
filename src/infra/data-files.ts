// Carrega e valida os arquivos de dados próprios em data/ (preços ilustrativos e premissas sintéticas).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import type { BusinessAssumptions } from "../domain/metrics/incident-metrics.ts";
import type { ModelPrices } from "../llm/usage.ts";
import { ValidationError } from "../domain/errors.ts";
import { formatIssues, parseWithIssues } from "../domain/validation.ts";

const positive = z.number().positive();

export const CloudPricesSchema: z.ZodType<CloudPrices> = z.object({
  version: z.string().min(1),
  note: z.string(),
  hoursPerMonth: positive,
  volumeGbMonthUsd: z.record(z.string(), positive),
  publicIpv4HourUsd: positive,
  instanceHourUsd: z.record(z.string(), positive),
});

export const BusinessAssumptionsSchema: z.ZodType<BusinessAssumptions> = z.object({
  version: z.string().min(1),
  note: z.string(),
  engineersEngaged: positive,
  engineerHourlyCostUsd: z.number().nonnegative(),
  copilotMonthlyCostUsd: positive,
  incidentsPerMonth: positive,
  revenuePerMinuteUsd: z.record(z.string(), z.number().nonnegative()),
  baselineMttrMin: z.record(z.string(), z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() })),
});

export const ModelPricesSchema: z.ZodType<ModelPrices> = z.object({
  version: z.string().min(1),
  note: z.string(),
  models: z.record(z.string(), z.object({ inputPerMTokUsd: z.number().nonnegative(), outputPerMTokUsd: z.number().nonnegative() })),
});

export function loadDataFile<T>(path: string, schema: z.ZodType<T>): T {
  const file = basename(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ValidationError(`data file ${file} unreadable or not JSON (${(e as Error).message})`, [{ path: file, message: "invalid JSON" }]);
  }
  const r = parseWithIssues(schema, raw);
  if (!r.success) {
    throw new ValidationError(`data file ${file} invalid at ${formatIssues(r.issues)}`, r.issues.map((i) => ({ path: `${file}:${i.path}`, message: i.message })));
  }
  return r.data;
}
