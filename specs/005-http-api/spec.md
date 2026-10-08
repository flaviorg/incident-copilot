# 005: API HTTP

Marco M5. Estado: implementado.

## Contexto

A API é a porta para quem quer integrar o copiloto: abrir incidentes, ler diagnóstico, trace, auditoria e post-mortem, e decidir aprovações com token. É também a única porta por onde um humano aprova. Os códigos de erro são estáveis e sem stack. Toda resposta carrega `X-Request-Id`, que chega ao trace, aos logs e à auditoria.

## Escopo

- `buildServer(container)` em Fastify 5, sem `listen`, testável por `app.inject`. `src/index.ts` sobe a API em `127.0.0.1:3000`, com encerramento limpo.
- Rotas:
  - `GET /health` e `GET /scenarios`;
  - `POST /incidents`, `GET /incidents`, `GET /incidents/:id`;
  - `GET /incidents/:id/trace`, `/audit` e `/postmortem`;
  - `GET /approvals` e `POST /approvals/:id/decision`;
  - `GET /stats`.
- Corpo de erro `{ error: { code, message, requestId, issues? } }`. Erros tipados traduzidos em status. Corpo até 64 KB. Redação de segredos no `onSend`.
- `X-Request-Id` reaproveitado quando casa `^[A-Za-z0-9._-]{1,64}$`; senão, gerado.
- `/stats` com agregações em SQL: contagens, MTTR P50 e P95 por posto mais próximo, faixas, aprovações com expiração projetada, contadores das guardas e uso do LLM.
- Timeout de execução por `RUN_TIMEOUT_MS` (504).

## Non-goals

- CORS: nenhum navegador fala com a API na v1. O modo ao vivo da War Room está no backlog v2.
- Rate limit HTTP (`@fastify/rate-limit`): a API escuta só em `127.0.0.1`. Há limite de execuções e bloqueio por tentativas de token.
- Autenticação de leitura: só a decisão exige token.
- Streaming de trace (SSE).
- Imagem Docker e deploy do backend.

## Critérios de aceite (EARS)

- **AC-01** Quando `POST /incidents` receber um `scenarioId` existente, o sistema deve criar o incidente, executar a equipe até `awaiting_approval`, `resolved` ou `escalated`, persistir o status derivado pela tabela 4.5.2 e responder 201 com o `IncidentView`.
- **AC-16** Se o token de aprovação estiver ausente ou errado, então o sistema deve responder 401 com mensagem genérica, gravar `approval_auth_failed` sem o valor recebido e não mudar o estado.
- **AC-18** Se houver 5 tentativas de token erradas em 10 minutos, então o sistema deve recusar decisões por 10 minutos com 429.
- **AC-30** Se a execução passar de `RUN_TIMEOUT_MS`, então a API deve responder 504 e o incidente deve ficar `escalated` com `timeout` e post-mortem parcial.
- **AC-32** Quando o corpo ou a query falhar na validação Zod, a API deve responder 400 com `code: "validation_error"` e `issues`, sem stack trace; e toda resposta deve trazer `X-Request-Id`, reaproveitando o recebido quando válido.
- **AC-33** Quando `GET /stats` for chamado, o sistema deve devolver contagens e MTTR P50 e P95 calculados por SQL sobre a janela pedida.

Endpoints e erros (seção 5.3 do design):

| Rota | Sucesso | Erros |
|---|---|---|
| `POST /incidents` | 201 `IncidentView` | 400; 404 `scenario_not_found`; 503 `llm_unavailable`; 504 `run_timeout` |
| `GET /incidents/:id/postmortem` | 200 Markdown ou JSON | 404; 409 `postmortem_not_ready` |
| `POST /approvals/:id/decision` | 200 `{ approval, incident }`, inclusive quando a retomada escala | 400; 401 `invalid_token`; 404; 409 `approval_not_pending`, `approval_expired` ou `incident_not_accepting` (execução do incidente ainda em andamento); 422 `ambiguous_decision`; 429 `approvals_locked`; 503 `approvals_disabled` |

## Como verificar

| Critério | Testes |
|---|---|
| AC-01 | `tests/e2e/http.e2e.test.ts` ("POST /incidents creates and stops awaiting approval") |
| AC-16 | `tests/e2e/http.e2e.test.ts` ("decision codes: 401, 422, 400, 200, 409"); `tests/e2e/gate.e2e.test.ts` ("token rules") |
| AC-18 | `tests/e2e/http.e2e.test.ts` ("429 after five wrong tokens, 503 without APPROVAL_TOKEN, 409 approval_expired") |
| AC-30 | `tests/e2e/resilience.e2e.test.ts` ("504 run_timeout with a real abort", "RUN_TIMEOUT_MS is a ceiling even when the run never yields to the event loop (fake without delay)") |
| AC-32 | `tests/e2e/http.e2e.test.ts` ("400 with issues, 404 for unknown scenario", "valid incoming request id is reused; invalid is replaced") |
| AC-33 | `tests/unit/stats.unit.test.ts`; `tests/e2e/http.e2e.test.ts` ("GET /stats after an approved, a rejected and an expired run") |

Marco demonstrável: a sequência de `curl` do README contra `npm start`.

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "4.4 HTTP: Fastify, não Express";
- "5.3 Endpoints HTTP";
- "6.1 Taxonomia de erros";
- "6.9 Observabilidade";
- "8.3 Critérios de aceite em EARS".

Números de seção citados nos critérios (como "tabela 4.5.2") apontam para esse documento. A tabela de status está em `docs/architecture.md`.
