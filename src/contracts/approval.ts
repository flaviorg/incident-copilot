import * as z from "zod";
import { ApprovalStatusSchema } from "./enums.ts";

export const ApprovalSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  actionId: z.string(),
  status: ApprovalStatusSchema,
  requestedAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  approver: z.string().nullable(),
  comment: z.string().nullable(), // the comment goes through redaction
  decisionSource: z.enum(["structured", "text", "expiry"]).nullable(),
  version: z.number().int().nonnegative(),
  // Spec 009: set only on code-fix approvals (actionId then holds the attempt id). No defaults, so action approvals
  // parse to the same bytes as before.
  subject: z.enum(["code_fix"]).optional(),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
