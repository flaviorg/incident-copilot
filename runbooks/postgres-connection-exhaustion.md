---
id: postgres-connection-exhaustion
title: Esgotamento de conexões com o Postgres
service: [orders-api, payments-api]
category: [dependency_failure, capacity]
---

## Sintomas

Erros 5xx intermitentes e latência alta em serviços que dependem do Postgres. Os logs mostram timeouts ao obter conexão do pool ou recusas por excesso de conexões. O uso do pool fica perto do máximo configurado.

## Diagnóstico

Confira o número de conexões ativas no banco e o tamanho máximo do pool de cada serviço. Verifique se há consultas lentas segurando conexões ou se um aumento de réplicas multiplicou as conexões sem ajuste do pool. Se o problema começou junto com uma mudança, revise a configuração do pool nessa mudança.

## Mitigação

Reduza o pool por réplica ou coloque um pooler de conexões na frente do banco. Encerre consultas presas que seguram conexões por muito tempo. Escale o banco só depois de confirmar que o gargalo é de capacidade.

## Prevenção

Monitore o uso do pool e alerte acima de 80%. Defina timeouts de consulta e de obtenção de conexão. Faça testes de carga com o número real de réplicas de produção.
