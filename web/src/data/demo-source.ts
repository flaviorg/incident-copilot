// Fonte do modo demo (spec 10.2; AC-39): só busca arquivos em ./demo/ e só aceita o que passa no schema. Erro de
// rede, HTTP, JSON ou schema vira mensagem explícita, sem devolver nada parcial.
import { DemoRecordingSchema, ScenarioSummarySchema } from "@contracts";
import type { DemoRecording, ScenarioSummary } from "@contracts";
import type * as z from "zod";

export type LoadResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SCENARIO_ID = /^[a-z0-9-]+$/;
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** `invalid` é o prefixo da mensagem de conteúdo inválido ("invalid recording", "invalid index"). */
async function loadJson<T>(url: string, schema: z.ZodType<T>, invalid: string, fetchImpl: typeof fetch): Promise<LoadResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch {
    return { ok: false, error: `could not load ${url}` };
  }
  if (!response.ok) return { ok: false, error: `could not load ${url} (HTTP ${response.status})` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: `${invalid}: ${url} is not JSON` };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: `${invalid}: ${describeIssues(parsed.error)}` };
  return { ok: true, value: parsed.data };
}

export function loadIndex(fetchImpl: typeof fetch = defaultFetch): Promise<LoadResult<ScenarioSummary[]>> {
  return loadJson("./demo/index.json", ScenarioSummarySchema.array(), "invalid index", fetchImpl);
}

export async function loadRecording(id: string, fetchImpl: typeof fetch = defaultFetch): Promise<LoadResult<DemoRecording>> {
  if (!SCENARIO_ID.test(id)) return { ok: false, error: "invalid scenario id" };
  return loadJson(`./demo/${id}.json`, DemoRecordingSchema, "invalid recording", fetchImpl);
}
