import * as z from "zod";
import { ConfidenceSchema, RootCauseCategorySchema } from "./enums.ts";

export const EvidenceSchema = z.object({
  source: z.enum(["metrics", "logs", "deploys", "inventory"]),
  ref: z.string().describe("Referência estável ao sinal, ex.: metrics:orders-api:http_5xx_rate@09:40-09:55"),
  summary: z.string().max(300),
});

export const DiagnosisSchema = z.object({
  hypothesis: z.string().max(400),
  category: RootCauseCategorySchema,
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceSchema).min(1).max(8),
  capReached: z.boolean(),
});
