// Shared route parameters (validated with parseOr400 like body and query).
import * as z from "zod";

export const IdParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** X-Approval-Token: only a string counts; a repeated header counts as absent (401). */
export function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
