---
id: orders-5xx-after-deploy
title: 5xx no orders-api logo após um deploy
service: [orders-api]
category: [bad_deploy]
---

## Sintomas

A taxa de respostas 5xx do orders-api passa de 5% poucos minutos depois de um deploy novo. A latência P99 costuma subir junto. Os erros aparecem só nas réplicas que já rodam a versão nova; a versão anterior estava estável.

## Diagnóstico

Compare o início do pico de 5xx com o horário do último deploy do orders-api. Agrupe os logs de ERROR por mensagem e confira em qual versão cada exceção aparece (por exemplo, um TypeError num formatador). Se o erro só existe na versão nova e começou junto com o rollout, trate como bad deploy. Se ele também aparece na versão anterior, procure outra causa antes de reverter.

## Mitigação

Faça rollback do deployment do orders-api para a versão anterior estável; é uma ação de alto impacto e exige aprovação humana. Depois do rollback, bloqueie a tag da imagem da versão com defeito para que nenhum pipeline a promova de novo. Registre no incidente uma nota com a versão revertida e o motivo. Acompanhe a taxa de 5xx e a latência P99 por alguns minutos antes de encerrar.

## Prevenção

Promova versões com rollout gradual e canário automático antes de atingir todas as réplicas. Cubra com teste os caminhos que leem campos opcionais (como a moeda de um preço). Mantenha a versão anterior pronta para rollback rápido e documente quem pode aprovar.
