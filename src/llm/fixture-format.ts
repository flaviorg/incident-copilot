// Formato das fixtures do provedor fake (spec 7.2): um arquivo por cenário em fixtures/llm/<cenário>.json.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { ValidationError } from "../domain/errors.ts";
import { formatIssues, parseWithIssues } from "../domain/validation.ts";

const FixtureErrorKindSchema = z.enum(["timeout", "rate_limit", "server_error", "invalid_output"]);

export const FixtureTurnSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    output: z.unknown().optional(),
    error: z.object({ kind: FixtureErrorKindSchema }).optional(),
    usage: z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative() }).optional(),
    delayMs: z.number().int().nonnegative().optional(),
  })
  .refine((t) => (t.output === undefined) !== (t.error === undefined), { message: "use exactly one of output and error", path: ["output"] });

export const FixtureFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().min(1),
    promptHashes: z.record(z.string(), z.string()),
    turns: z.array(FixtureTurnSchema),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.turns.forEach((t, i) => {
      if (seen.has(t.id)) ctx.addIssue({ code: "custom", path: ["turns", i, "id"], message: `repeated turn id: ${t.id}` });
      seen.add(t.id);
    });
  });

export type FixtureErrorKind = z.infer<typeof FixtureErrorKindSchema>;
export type FixtureTurn = z.infer<typeof FixtureTurnSchema>;
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

/** Lê e valida `<dir>/*.json` em ordem de nome. Pasta ausente devolve lista vazia. */
export function loadFixtures(dir: string): FixtureFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch (e) {
        throw new ValidationError(`fixture ${file} is not valid JSON (${(e as Error).message})`, [{ path: file, message: "invalid JSON" }]);
      }
      const r = parseWithIssues(FixtureFileSchema, raw);
      if (!r.success) {
        throw new ValidationError(`fixture ${file} invalid at ${formatIssues(r.issues)}`, r.issues.map((i) => ({ path: `${file}:${i.path}`, message: i.message })));
      }
      return r.data;
    });
}
