# API HTTP

`npm start` sobe a API Fastify em `127.0.0.1:3000`. Corpo de erro: `{ "error": { "code", "message", "requestId", "issues"? } }`, sem stack. Toda resposta traz `X-Request-Id`. Resumo no [README](../README.md#http-api).

## Rotas

| Rota | Faz | Erros |
|---|---|---|
| `GET /health` | provedor e versão | nenhum |
| `GET /scenarios` | cenários disponíveis | nenhum |
| `POST /incidents` | abre e executa a equipe até `awaiting_approval`, `resolved` ou `escalated` (201) | 400; 404 `scenario_not_found`; 503 `llm_unavailable`; 504 `run_timeout` |
| `GET /incidents` | lista com filtro em SQL (`status`, `service`, `limit`) | 400 |
| `GET /incidents/:id` | visão completa: diagnóstico, plano, ações, aprovações, métricas | 404 |
| `GET /incidents/:id/trace` | eventos em ordem de `seq` (`type`, `agent`, `limit`) | 404 |
| `GET /incidents/:id/audit` | trilha de auditoria com `prevHash` e `hash`, verificável pelo cliente (`incidentId` vem da URL) | 404 |
| `GET /incidents/:id/postmortem` | Markdown ou JSON (`format=md\|json`) | 404; 409 `postmortem_not_ready` |
| `GET /approvals` | aprovações com status efetivo (vencida aparece `expired`, sem gravar) | 400 |
| `POST /approvals/:id/decision` | decide com `X-Approval-Token`; retoma quando não resta pendência | 400; 401; 404; 409; 422; 429; 503 |
| `GET /stats` | contagens, MTTR P50 e P95, faixas, guardas e uso do LLM, tudo em SQL (`since=1h\|24h\|7d`) | 400 |

## Sequência real com `curl`

Sequência real contra `npm start`, com banco novo e um token local de 16 caracteres ou mais exportado no shell como `APPROVAL_TOKEN` (o valor não aparece em nenhuma saída):

```text
$ npm start   # em outro terminal
{"ts":"2026-10-04T10:42:52.003Z","level":"info","msg":"api ouvindo","host":"127.0.0.1","port":3000,"provider":"fake"}

$ curl -s localhost:3000/health | jq -c .
{"status":"ok","provider":"fake","version":"0.1.0"}

$ curl -s -X POST localhost:3000/incidents -H 'content-type: application/json' -d '{"scenarioId":"deploy-5xx-rollback"}' | jq -c '{id: .incident.id, status: .incident.status, pendentes: [.approvals[] | select(.status=="pending") | .id]}'
{"id":"INC-0001","status":"awaiting_approval","pendentes":["APR-0001"]}

$ curl -s -X POST localhost:3000/approvals/APR-0001/decision -H 'content-type: application/json' -H 'X-Approval-Token: errado-errado-errado' -d '{"decision":"approve","approver":"ana"}' | jq -c .error
{"code":"invalid_token","message":"token de aprovação inválido ou ausente","requestId":"af8556c4-46a9-49aa-85c2-a28c89248c29"}

$ curl -s -X POST localhost:3000/approvals/APR-0001/decision -H 'content-type: application/json' -H "X-Approval-Token: $APPROVAL_TOKEN" -d '{"text":"sim, mas espera","approver":"ana"}' | jq -c .error.code
"ambiguous_decision"

$ curl -s -X POST localhost:3000/approvals/APR-0001/decision -H 'content-type: application/json' -H "X-Approval-Token: $APPROVAL_TOKEN" -d '{"decision":"approve","approver":"ana"}' | jq -c '.incident.incident.status'
"resolved"

$ curl -s 'localhost:3000/stats?since=24h' | jq -c '{incidents: .incidents.byStatus, mttr: .mttrMin, faixas: .actions.byTier}'
{"incidents":{"open":0,"investigating":0,"awaiting_approval":0,"mitigating":0,"resolved":1,"escalated":0},"mttr":{"p50":2.003,"p95":2.003},"faixas":{"1":0,"2":2,"3":1,"4":0}}

$ curl -s localhost:3000/incidents/INC-0001/postmortem | head -6
# Post-mortem INC-0001: Taxa de 5xx acima de 5% no orders-api

- Status: final
- Serviço: orders-api
- Narrativa: template determinístico
- Formato sem culpa: descreve o sistema e as decisões, não pessoas.

$ curl -s 'localhost:3000/incidents/INC-0001/postmortem?format=json' | jq -c .numericGuard
{"passed":false,"rejectedNumbers":["11,2"],"usedTemplate":true}
```

Com o relógio do sistema, o cenário é deslocado para que o alerta coincida com a abertura, e o MTTR da API depende de quanto o operador leva para aprovar: neste exemplo, cerca de 2 min.

O post-mortem saiu pelo template porque o [guarda numérico](../README.md#numbers-without-invention) rejeitou o "11,2" da narrativa roteirizada: esse é o MTTR da linha do tempo simulada, e com o relógio do sistema o MTTR real foi outro.
