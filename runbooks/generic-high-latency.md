---
id: generic-high-latency
title: Latência alta em qualquer serviço
service: [*]
category: [capacity, dependency_failure, unknown]
---

## Sintomas

A latência P99 sobe bem acima da linha de base, com ou sem aumento de erros. Usuários relatam lentidão e filas de requisições crescem.

## Diagnóstico

Verifique saturação de CPU, memória e threads do serviço. Meça a latência de cada dependência (banco, filas, APIs externas) para achar onde o tempo é gasto. Compare a vazão atual com a de dias normais para separar pico de tráfego de regressão.

## Mitigação

Se for pico de tráfego, aumente réplicas ou ative cache para as rotas mais chamadas. Se uma dependência estiver lenta, aplique timeout e circuit breaker para proteger o serviço. Se a regressão for recente, avalie desfazer a última mudança.

## Prevenção

Defina orçamento de latência por rota e alerte quando ele for consumido rápido demais. Faça testes de carga periódicos e acompanhe a latência das dependências em painéis próprios.
