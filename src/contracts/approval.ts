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
  comment: z.string().nullable(), // comentário passa por redação
  decisionSource: z.enum(["structured", "text", "expiry"]).nullable(),
  version: z.number().int().nonnegative(),
});
