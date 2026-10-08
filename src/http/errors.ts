// Tradução de erros tipados em status HTTP e corpo de erro (spec 5.3 e 6.1). Sem stack e sem mensagem bruta de
// biblioteca: erro inesperado vira 500 internal_error com texto genérico, e o detalhe fica só no log (com requestId).
import type * as z from "zod";
import type { ErrorBody as ErrorBodyContract } from "../contracts/index.ts";
import {
  ApprovalsDisabledError, AuthError, ConflictError, LlmUnavailableError, LockedError, NotFoundError, RunTimeoutError,
  UnprocessableError, ValidationError,
} from "../domain/errors.ts";
import { formatIssues, parseWithIssues } from "../domain/validation.ts";

export type ErrorBody = ErrorBodyContract;

export type HttpError = {
  status: number;
  body: ErrorBody;
  /** true quando o erro não é do domínio nem da borda: quem chama loga o detalhe em stderr. */
  unexpected: boolean;
};

const INTERNAL_ERROR_MESSAGE = "erro interno";

const body = (code: string, message: string, requestId: string, issues?: { path: string; message: string }[]): ErrorBody => ({
  error: { code, message, requestId, ...(issues ? { issues } : {}) },
});

/** Erro do Fastify (parser de corpo, limite de tamanho): tem `code` FST_* e `statusCode`. */
function fastifyError(e: unknown): { code: string; statusCode: number } | null {
  if (typeof e !== "object" || e === null) return null;
  const code = (e as { code?: unknown }).code;
  const statusCode = (e as { statusCode?: unknown }).statusCode;
  if (typeof code !== "string" || !code.startsWith("FST_") || typeof statusCode !== "number") return null;
  return { code, statusCode };
}

export function toHttpError(e: unknown, requestId: string): HttpError {
  const known = (status: number, code: string, message: string, issues?: { path: string; message: string }[]): HttpError => ({
    status, body: body(code, message, requestId, issues), unexpected: false,
  });
  if (e instanceof ValidationError) return known(400, "validation_error", e.message, e.issues);
  if (e instanceof NotFoundError) return known(404, e.code, e.message);
  if (e instanceof ConflictError) return known(409, e.code, e.message);
  if (e instanceof UnprocessableError) return known(422, e.code, e.message);
  if (e instanceof AuthError) return known(401, e.code, "token de aprovação inválido ou ausente");
  if (e instanceof LockedError) return known(429, e.code, e.message);
  if (e instanceof ApprovalsDisabledError) return known(503, e.code, e.message);
  if (e instanceof LlmUnavailableError) return known(503, e.code, e.message);
  if (e instanceof RunTimeoutError) return known(504, e.code, e.message);

  const f = fastifyError(e);
  if (f) {
    if (f.code === "FST_ERR_CTP_BODY_TOO_LARGE") return known(413, "payload_too_large", "corpo da requisição acima de 64 KB");
    if (f.code === "FST_ERR_CTP_INVALID_JSON_BODY" || f.code === "FST_ERR_CTP_EMPTY_JSON_BODY") return known(400, "invalid_json", "corpo JSON inválido");
    if (f.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return known(415, "unsupported_media_type", "content-type não suportado; use application/json");
    if (f.statusCode >= 400 && f.statusCode < 500) return known(f.statusCode, "bad_request", "requisição inválida");
  }
  // JSON malformado no parser padrão chega como SyntaxError com statusCode 400.
  if (e instanceof SyntaxError && (e as { statusCode?: unknown }).statusCode === 400) return known(400, "invalid_json", "corpo JSON inválido");

  return { status: 500, body: body("internal_error", INTERNAL_ERROR_MESSAGE, requestId), unexpected: true };
}

/** Valida corpo, params ou query com Zod (mensagens em pt-BR); falha vira ValidationError com issues { path, message }. */
export function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = parseWithIssues(schema, value);
  if (!r.success) throw new ValidationError(`entrada inválida: ${formatIssues(r.issues)}`, r.issues);
  return r.data;
}
