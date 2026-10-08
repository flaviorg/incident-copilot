# Saída completa da demo de terminal

Saída real dos dois cenários, copiada do terminal. A demo roda offline com o provedor fake roteirizado e força o fake mesmo que o shell tenha `OPENROUTER_API_KEY` (só `--live` usa o modelo real). O relógio é simulado, por isso os horários e o MTTR se repetem a cada execução. Resumo e contexto no [README](../README.md#início-rápido).

## Cenário `deploy-5xx-rollback` (padrão)

```text
$ npm run demo
incident-copilot · demo · provedor: fake roteirizado (sem rede, sem chave)
cenário deploy-5xx-rollback · serviço orders-api · sev1

09:42:30  INC-0001 aberto: "Taxa de 5xx acima de 5% no orders-api" (impacto desde 09:40:30)
09:42:50  supervisor → analista de telemetria: Correlacione 5xx e latência do orders-api com o deploy v3.8.0
09:43:10    pensa Preciso confirmar o tamanho do pico de 5xx e quando ele começou.
09:43:10    ação  query_metrics(orders-api, http_5xx_rate, 30m) · faixa 1
09:43:13    obs   http_5xx_rate de orders-api em 30m (09:13:10–09:43:10 UTC, 60 amostras): início 0,2%, pico 9,9% às 09:40:30, último 9,3%, média 1,3%. Primeira amostra acima do limiar do alerta (5,0%) às 09:40:30.
09:43:33    pensa O pico começou por volta de 09:40; vou ver se houve deploy recente do orders-api.
09:43:33    ação  list_deploys(orders-api) · faixa 1
09:43:36    obs   1 deploy(s) de orders-api nos últimos 7 dias, do mais recente: v3.8.0 em 04/10 09:40 UTC, 4 min atrás (anterior v3.7.2, 6 réplicas). Versão em execução agora: v3.8.0 (6 réplicas).
09:43:56    pensa Houve deploy da v3.8.0 às 09:40. Vou agrupar os erros dos últimos 15 minutos por mensagem e versão.
09:43:56    ação  query_logs(orders-api, ERROR, 15m) · faixa 1
09:43:59    obs   380 linhas ERROR de orders-api em 15m, 1 grupo(s); mais frequentes: [380x, versões v3.8.0, desde 09:40:40] TypeError: Cannot read properties of undefined (reading 'currency') at PriceFormatter.format
09:44:19    pensa Os 5xx começaram junto com o rollout da v3.8.0 e o único erro frequente existe só nessa versão. A evidência aponta para deploy com defeito.
09:44:19  analista de telemetria: diagnóstico bad_deploy (deploy com defeito, confiança alta, 3 evidências): O deploy v3.8.0 do orders-api introduziu um TypeError em PriceFormatter.format ao ler currency de preços sem moeda; os 5xx começaram junto com o rollout.
09:44:19  analista de telemetria → supervisor: diagnóstico bad_deploy (deploy com defeito, confiança alta, 3 evidências)
09:44:39  supervisor → recuperador de runbooks: Procure runbooks de 5xx depois de deploy no orders-api
09:44:39    ação  search_runbooks(5xx acima de 5% por 2 min O deploy v3.8.0 do orders-api introduziu um TypeError em PriceFormatter.format ao ler currency de preços sem moeda; os 5xx começaram …) · faixa 1
09:44:39    obs   orders-5xx-after-deploy@d47b28 §mitigacao (escore normalizado 0,08); orders-5xx-after-deploy@d47b28 §diagnostico (escore normalizado 0,08); orders-5xx-after-deploy@d47b28 §sintomas (escore normalizado 0,08)
09:44:39  recuperador de runbooks → supervisor: 3 trecho(s) de runbook: orders-5xx-after-deploy#mitigacao, orders-5xx-after-deploy#diagnostico, orders-5xx-after-deploy#sintomas
09:44:59  supervisor → planejador de remediação: Monte o plano de remediação a partir do runbook de 5xx depois de deploy
09:45:19  planejador de remediação: plano revisão 0 com 3 passos: Reverter o orders-api para a v3.7.2, registrar o motivo no incidente e bloquear a imagem 3.8.0 para que não seja promovida de novo.
09:45:19  planejador de remediação → auditor: plano revisão 0 com 3 passos
09:45:39  auditor: aprovado (Plano coerente com o diagnóstico: rollback para a versão anterior ao deploy, nota no incidente e bloqueio da tag só depois do rollback.)
09:45:39  auditor → supervisor: plano revisão 0 aprovado (5 de 5 regras ok)
09:45:59  supervisor → portão de remediação: Avalie o risco de cada passo do plano auditado
09:46:05    ação  add_incident_note(incident/orders-api, Rollback do orders-api de v3.8.0 para v3.7.2: TypeError em PriceFormatter.format após o deploy.) · faixa 2
09:46:05    obs   add_incident_note faixa 2: dry run ok (incident/orders-api: nota registrada) → pronto, executa após as decisões
09:46:05    ação  rollback_deployment(deployment/orders-api, v3.7.2) · faixa 3
09:46:05    obs   rollback_deployment faixa 3: dry run ok (deployment/orders-api: v3.8.0 -> v3.7.2 (6 réplicas)) → aguardando APR-0001
09:46:05    ação  block_image_tag(image/orders-api:3.8.0) · faixa 2
09:46:05    obs   block_image_tag faixa 2: dry run ok (image/orders-api:3.8.0: tag bloqueada para promoção) → pronto, executa após as decisões, depende do passo 2
09:46:05  portão de remediação → humano: aguardando aprovação de APR-0001
09:49:05  operador demo aprovou APR-0001 (token verificado, valor omitido)
09:49:05  humano → executor: decisões registradas: 1 aprovada(s), 0 rejeitada(s), 0 expirada(s)
09:49:05    ação  add_incident_note(incident/orders-api, Rollback do orders-api de v3.8.0 para v3.7.2: TypeError em PriceFormatter.format após o deploy.) · faixa 2
09:49:06    obs   add_incident_note: incident/orders-api: nota registrada
09:49:06    ação  rollback_deployment(deployment/orders-api, v3.7.2) · faixa 3
09:50:36    obs   rollback_deployment: deployment/orders-api: v3.8.0 -> v3.7.2 (6 réplicas)
09:50:36    ação  block_image_tag(image/orders-api:3.8.0) · faixa 2
09:50:41    obs   block_image_tag: image/orders-api:3.8.0: tag bloqueada para promoção
09:51:41  canário: aprovado (canário saudável: 5xx 0,5% ≤ 5%; P99 205 ms ≤ 270 ms)
09:51:41  verificador → supervisor: canário saudável; incidente mitigado
09:52:01  supervisor → relator: Redija o post-mortem do incidente resolvido
09:52:21  relator: O deploy v3.8.0 do orders-api introduziu um TypeError em PriceFormatter.format e a taxa de 5xx passou do limiar logo após o rollout. O incidente foi detectado em 2 min e resolvido com rollback para v3.7.2 aprovado por humano; o MTTR foi de 11,2 min, dos quais…

desfecho: resolvido (canário saudável)

MTTR                    11,2 min        medido (linha do tempo simulada, 09:40:30 → 09:51:41)
  aguardando aprovação  3,0 min         medido (soma das aprovações decididas)
MTTD                    2,0 min         medido
Minutos economizados    33,8 a 83,8     ilustrativo (linha de base sintética de 45 a 95 min)
ROI                     18,9x a 48,2x   ilustrativo (premissas em data/business-assumptions.json)
Custo de LLM            US$ 0,00        medido (12 chamadas, 14014 tokens)

trace 41 eventos (thought 4 · action 10 · observation 10 · plan 1 · critique 2 · answer 2 · handoff 12)
post-mortem: reports/INC-0001-postmortem.md
```

## Cenário `cost-anomaly` (trecho)

O trecho mostra o Reflection (o auditor devolve a revisão 0 pela regra em código `snapshot_before_delete`), o `delete_backups` de faixa 4 bloqueado sem dry run e as três aprovações de faixa 3.

```text
$ npm run demo -- --scenario cost-anomaly
incident-copilot · demo · provedor: fake roteirizado (sem rede, sem chave)
cenário cost-anomaly · conta data-platform · sev3

(...)
08:02:06  supervisor → planejador de remediação: Planeje o corte dos recursos ociosos apontados pelo inventário
08:02:26  planejador de remediação: plano revisão 0 com 5 passos: Cortar o custo ocioso da conta data-platform: marcar e excluir o volume sem anexo, liberar o IPv4 ocioso, redimensionar a instância subutilizada e apagar backu…
08:02:26  planejador de remediação → auditor: plano revisão 0 com 5 passos
08:02:46  auditor: pede revisão (Falta snapshot do volume vol-0c41d2 antes da exclusão: inclua create_volume_snapshot e faça delete_volume depender dele. | regras falhas: snapshot_before_delete)
08:02:46  auditor → planejador de remediação: revise o plano: Falta snapshot do volume vol-0c41d2 antes da exclusão: inclua create_volume_snapshot e faça delete_volume depender dele. | regras falhas: snapshot_before_delete
08:03:06  planejador de remediação: plano revisão 1 com 6 passos: Cortar o custo ocioso da conta data-platform com snapshot do volume antes da exclusão, liberação do IPv4 ocioso, redimensionamento da instância subutilizada e …
08:03:06  planejador de remediação → auditor: plano revisão 1 com 6 passos
08:03:26  auditor: aprovado (O snapshot vem antes da exclusão e os demais passos seguem os achados do inventário.)
08:03:26  auditor → supervisor: plano revisão 1 aprovado (5 de 5 regras ok)
08:03:46  supervisor → portão de remediação: Avalie o risco de cada passo do plano revisado
08:03:56    ação  tag_resource_for_review(volume/data-platform/vol-0c41d2, volume gp3 sem anexo há 23 dias) · faixa 2
08:03:56    obs   tag_resource_for_review faixa 2: dry run ok (volume/data-platform/vol-0c41d2: marcado para revisão (volume gp3 sem anexo há 23 dias)) → pronto, executa após as decisões
08:03:56    ação  create_volume_snapshot(volume/data-platform/vol-0c41d2) · faixa 2
08:03:56    obs   create_volume_snapshot faixa 2: dry run ok (volume/data-platform/vol-0c41d2: snapshot de 750 GB criado) → pronto, executa após as decisões
08:03:56    ação  delete_volume(volume/data-platform/vol-0c41d2) · faixa 3
08:03:56    obs   delete_volume faixa 3: dry run ok (volume/data-platform/vol-0c41d2: volume gp3 de 750 GB excluído), depende do passo 2 → aguardando APR-0001
08:03:56    ação  release_elastic_ip(ip/data-platform/eipalloc-0f19) · faixa 3
08:03:56    obs   release_elastic_ip faixa 3: dry run ok (ip/data-platform/eipalloc-0f19: IPv4 público liberado) → aguardando APR-0002
08:03:56    ação  resize_instance(instance/data-platform/i-07ab3, r6i.large) · faixa 3
08:03:56    obs   resize_instance faixa 3: dry run ok (instance/data-platform/i-07ab3: r6i.2xlarge -> r6i.large) → aguardando APR-0003
08:03:56    ação  delete_backups(backup_vault/data-platform/data-platform-prod) · faixa 4
08:03:56    obs   delete_backups faixa 4: bloqueado sem dry run (proibida por construção (faixa 4))
08:03:56  portão: bloqueado (delete_backups em backup_vault/data-platform/data-platform-prod: proibida por construção (faixa 4))
08:03:56  portão de remediação → humano: aguardando aprovação de APR-0001, APR-0002, APR-0003
08:06:56  operador demo aprovou APR-0001 (token verificado, valor omitido)
08:09:56  operador demo aprovou APR-0002 (token verificado, valor omitido)
08:12:56  operador demo aprovou APR-0003 (token verificado, valor omitido)
08:12:56  humano → executor: decisões registradas: 3 aprovada(s), 0 rejeitada(s), 0 expirada(s)
(...)
08:19:53  canário: aprovado (canário saudável: custo mensal projetado US$ 356,94 ≤ US$ 600,00)
08:19:53  verificador → supervisor: canário saudável; incidente mitigado
08:20:13  supervisor → relator: Redija o post-mortem com a economia mensal das ações executadas
08:20:33  relator: Recursos ociosos na conta data-platform elevaram o custo diário. Com aprovação humana, o volume sem anexo foi excluído depois de um snapshot, o IPv4 ocioso foi liberado e a instância subutilizada foi redimensionada; a economia mensal das ações executadas é de…

desfecho: resolvido (canário saudável)

MTTR                    19,9 min        medido (linha do tempo simulada, 08:00:00 → 08:19:53)
  aguardando aprovação  18,0 min        medido (soma das aprovações decididas)
MTTD                    0,0 min         medido
Economia mensal         US$ 339,59      derivado (achados de inventário das ações executadas)
Minutos economizados    25,1 a 75,1     ilustrativo (linha de base sintética de 45 a 95 min)
ROI                     12,8x a 17,8x   ilustrativo (premissas em data/business-assumptions.json)
Custo de LLM            US$ 0,00        medido (13 chamadas, 15592 tokens)

trace 53 eventos (thought 3 · action 14 · observation 14 · plan 2 · critique 4 · answer 2 · handoff 14)
post-mortem: reports/INC-0001-postmortem.md
```

## Variações

- `npm run demo -- --reject`: o operador rejeita, o rollback é cancelado junto com o passo que dependia dele, e o incidente termina escalado com `mitigation_rejected`.
- `npm run demo -- --scenario cost-anomaly`: o cenário FinOps (trecho acima).
- `npm run demo -- --json`: só o objeto final.
- `npm run demo -- --persist`: grava em `data/incident-copilot.db`; a segunda execução vira `INC-0002`.
