---
id: cloud-cost-anomaly
title: Anomalia de custo na nuvem (cost anomaly)
service: [*]
category: [cost_anomaly]
---

## Sintomas

O custo diário da conta sobe bem acima da média dos últimos dias sem aumento equivalente de uso. A projeção de custo mensal passa do orçamento.

## Diagnóstico

Audite o inventário da conta atrás de recursos ociosos: volume sem anexo há vários dias, IP público ocioso sem associação e instância ociosa com CPU média baixa por duas semanas. Calcule a economia mensal de cada achado com a tabela de preços vigente. Cofres e pontos de backup não são desperdício: dependem da política de retenção.

## Mitigação

Antes de excluir um volume sem anexo, crie um snapshot dele, para a exclusão poder ser desfeita. Libere o IP ocioso e redimensione a instância ociosa para um tipo menor da mesma família. Exclusão de volume, liberação de IP e redimensionamento exigem aprovação humana. Nunca apague backups para cortar custo.

## Prevenção

Marque recursos com dono e data de revisão. Rode a auditoria de inventário toda semana e alerte quando o custo diário passar da média em mais de 20%.
