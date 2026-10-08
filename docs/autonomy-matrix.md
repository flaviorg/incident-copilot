# Matriz de Autonomia

> Arquivo gerado a partir de `src/domain/autonomy/catalog.ts` por `node scripts/gen-autonomy-doc.ts` (também roda em `npm run regen`). Não edite à mão: o teste `docs-matrix.unit.test.ts` falha se este arquivo divergir do catálogo.

A faixa de cada passo vem do catálogo e de regras de contexto que só sobem a faixa, nunca descem. A saída do modelo não tem campo de faixa.

## Faixas

| Faixa | Regra | O que entra |
|---|---|---|
| Faixa 1: decide sozinho | Leitura, risco zero | Ferramentas `query_metrics`, `query_logs`, `list_deploys`, `audit_cloud_inventory` |
| Faixa 2: decide e registra | Mudança reversível ou sem efeito no serviço, com auditoria | `add_incident_note`, `block_image_tag`, `tag_resource_for_review`, `create_volume_snapshot` |
| Faixa 3: exige aprovação humana | Destrutivo ou alto impacto | `rollback_deployment`, `release_elastic_ip`, `delete_volume`, `resize_instance` |
| Faixa 4: proibido por construção | Expor dados, apagar auditoria ou backup, desligar controle | `delete_audit_log`, `disable_security_scanner`, `export_user_data`, `run_arbitrary_command`, `delete_backups` e qualquer tipo fora do catálogo (negar por padrão) |

## Catálogo de ações executáveis

| Faixa | Tipo | Alvo | Parâmetros | Mitiga | Reversível | Duração simulada |
|---|---|---|---|---|---|---|
| 2 | `add_incident_note` | `incident/<serviço ou conta do incidente>` | `{ text: string }` | não | não | 1 s |
| 2 | `block_image_tag` | `image/<serviço>:<tag>` | `{}` | não | sim | 5 s |
| 2 | `tag_resource_for_review` | `<volume, ip ou instance>/<conta>/<id>` | `{ reason: string }` | não | sim | 2 s |
| 2 | `create_volume_snapshot` | `volume/<conta>/<id>` | `{}` | não | sim | 30 s |
| 3 | `rollback_deployment` | `deployment/<serviço>` | `{ toVersion: string }` | sim | sim | 90 s |
| 3 | `release_elastic_ip` | `ip/<conta>/<id>` | `{}` | sim | não | 5 s |
| 3 | `delete_volume` | `volume/<conta>/<id>` | `{}` | sim | não | 20 s |
| 3 | `resize_instance` | `instance/<conta>/<id>` | `{ toType: string }` | sim | sim | 300 s |

Parâmetros fora do schema do catálogo levam o passo a `rejected_invalid_params`, sem dry run.

## Regras de contexto (sobem para faixa 3)

- alvo fora do escopo do incidente: o alvo não é o próprio incidente nem pertence ao serviço ou à conta do incidente (raio de impacto).
- passo sem runbook de referência: o passo não cita um trecho de runbook (`runbookRef` nulo).
- revisões do plano esgotadas: o plano chegou ao portão com as revisões do auditor esgotadas e veredito final `revise`.

## Faixa 4 por construção

1. O registro de executores é tipado por `ExecutableActionType`, e os tipos proibidos não pertencem a ele: não existe código que os execute.
2. `classifyAction` devolve faixa 4 para proibidos e desconhecidos, e o portão bloqueia sem dry run e sem fila de aprovação.
3. A tabela `audit_log` tem gatilhos que abortam `UPDATE` e `DELETE`, e o store não tem método de remoção.
