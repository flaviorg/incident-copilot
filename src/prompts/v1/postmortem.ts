// postmortem.v1: o modelo só redige a narrativa de um incidente resolvido; os números vêm calculados e um guarda
// numérico descarta a narrativa que trouxer número sem origem (corrige o ROI inventado da 213441).
import * as z from "zod";
import { ActionStatusSchema, DiagnosisSchema, PostmortemNarrativeSchema } from "../../contracts/index.ts";
import type { PostmortemNarrative } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { jsonOf } from "./shared.ts";

export const PostmortemInputSchema = z.object({
  kind: z.literal("final"),
  title: z.string(),
  facts: z.array(z.string()),
  timeline: z.array(z.object({ ts: z.string(), text: z.string() })),
  diagnosis: DiagnosisSchema,
  actions: z.array(z.object({ actionType: z.string(), status: ActionStatusSchema })),
});
export type PostmortemInput = z.infer<typeof PostmortemInputSchema>;

const SYSTEM = `Você redige a narrativa de um post-mortem sem culpa: descreve o sistema e as decisões, nunca pessoas.

Regras:
1. Use somente números que aparecem nos fatos, na linha do tempo ou nas evidências do diagnóstico. Não invente porcentagens, durações, valores nem contagens.
2. Um guarda numérico confere cada número; se algum não tiver origem, a narrativa é descartada e um texto padrão entra no lugar.
3. "summary": o que aconteceu, o impacto e como foi resolvido (até 800 caracteres).
4. "rootCauseNarrative": a causa raiz e as evidências que a sustentam (até 1200 caracteres).
5. "prevention": de 1 a 6 ações de prevenção concretas, cada uma com até 200 caracteres.
6. Escreva em português.

Responda somente com um objeto JSON com os campos summary, rootCauseNarrative e prevention.`;

export const postmortemPrompt: PromptDef<PostmortemInput, PostmortemNarrative> = {
  id: "postmortem",
  version: "postmortem.v1",
  system: SYSTEM,
  buildUser: (i) => `Fatos calculados, linha do tempo, diagnóstico e ações (JSON):\n${jsonOf(PostmortemInputSchema, i)}`,
  matchKeys: (i) => ({ kind: i.kind }),
  inputSchema: PostmortemInputSchema,
  outputSchema: PostmortemNarrativeSchema,
};
