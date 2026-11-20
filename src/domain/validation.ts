// Validation with per-call English messages (without changing Zod's global configuration).
import * as z from "zod";
import type { Issue } from "./errors.ts";

const en = z.locales.en().localeError;

export type Parsed<T> = { success: true; data: T } | { success: false; issues: Issue[] };

export function parseWithIssues<T>(schema: z.ZodType<T>, value: unknown): Parsed<T> {
  const r = schema.safeParse(value, { error: en });
  if (r.success) return { success: true, data: r.data };
  return { success: false, issues: r.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message })) };
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `${i.path} (${i.message})`).join("; ");
}
