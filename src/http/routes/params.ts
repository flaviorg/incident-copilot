// Parâmetros de rota compartilhados (validados com parseOr400 como corpo e query).
import * as z from "zod";

export const IdParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** X-Approval-Token: só uma string conta; cabeçalho repetido vale como ausente (401). */
export function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
