# AGENTS.md

Instruções para agentes de código neste repositório. Princípios completos em `specs/constitution.md`; requisitos por marco em `specs/NNN-*/spec.md`.

## Comandos

| Comando | Faz |
|---|---|
| `npm test` | Suíte do backend (unitários e ponta a ponta), sem rede |
| `npm run test:unit` | Só unitários (o que o pre-commit roda) |
| `npm run typecheck` | `tsc --noEmit` do backend; `npm run typecheck:web` para a War Room |
| `npm run verify` | Tudo o que o CI roda: typecheck, testes, testes e build da web, `check:tokens`, `check:secrets` |
| `npm run demo` | Cenário `deploy-5xx-rollback` offline com o fake (`-- --scenario cost-anomaly`, `-- --reject`) |
| `npm run regen` | Regera os golden de métricas e `docs/autonomy-matrix.md` |
| `npm run fixtures:rehash` | Atualiza os hashes de prompt nas fixtures do fake |
| `npm run check:secrets` | Procura chaves e tokens na árvore |

A War Room precisa de `npm run web:install` uma vez, antes de `typecheck:web`, `web:test` e `web:build`.

## Mapa de pastas

| Pasta | Conteúdo |
|---|---|
| `src/contracts` | Schemas Zod e tipos compartilhados com a War Room. Sem lógica, sem I/O |
| `src/domain` | Regras puras: faixas, aprovação, auditor, guardas, canário, métricas, BM25 |
| `src/infra` | SQLite, cenários, runbooks, mundo simulado, relógio, ids, logger, redação |
| `src/llm`, `src/prompts/v1` | Provedores (fake e OpenRouter), resiliência, prompts versionados |
| `src/graph` | Grafo LangGraph, rotas e nós (um por arquivo, criados por fábrica) |
| `src/app` | Serviços de aplicação e `container.ts` |
| `src/http`, `src/mcp`, `src/cli` | Portas: API Fastify, servidor MCP stdio, CLI |
| `fixtures/` | Cenários com dados próprios e roteiros do fake |
| `tests/` | `unit`, `e2e`, `golden`, `fixtures/llm` (roteiros só de teste), `helpers`, `live` |
| `web/` | War Room (pacote aninhado, instalação própria) |
| `docs/`, `specs/` | Documentação técnica, post-mortems e specs SDD |

## Regras

- **TDD.** Escreva o teste, veja falhar, implemente o mínimo, veja passar. Testes em `tests/unit/*.unit.test.ts` ou `tests/e2e/*.e2e.test.ts`, com `node:test` e `node:assert/strict`.
- **Sem rede nos testes.** `fetch` é bloqueado por `tests/setup/no-network.ts`. Processos filhos de teste sobem com `--import ./tests/setup/no-network.ts`. Nunca use chave real.
- **Zod 4:** `import * as z from "zod"`. Nunca `zod/v3`.
- **Domínio puro.** `src/contracts` e `src/domain` não importam `node:*` nem camadas externas (há teste).
- **TypeScript nativo do Node 24.** Imports relativos com `.ts`, `import type` para tipos, sem `enum` nem `namespace`.
- **A faixa vem do catálogo.** Nunca leia faixa, aprovação ou decisão de execução da saída do LLM. Regras de contexto só sobem a faixa.
- **Nunca ecoe segredo.** Todo texto que sai do processo passa por `redactSecrets`. Testes que precisam de valor com formato de chave montam o valor em tempo de execução (`"sk-or-v1-" + "a".repeat(40)`).
- **Fixture muda junto com prompt.** Mudou um `system` em `src/prompts/v1`? Rode `npm run fixtures:rehash`. Mudou entrada ou fluxo? Ajuste os turnos. Detalhes em `docs/fake-provider.md`.
- **Golden só muda de propósito.** Rode `npm run regen` e revise o diff antes de aceitar.
- **Não teste texto livre de LLM por igualdade.** Afirme estrutura, enums, estado e números.
- **Idiomas.** Identificadores em inglês; texto para pessoas em pt-BR.
- **Dependência nova exige justificativa** e versão exata.
- **Não publique nada.** Sem `git push`, `npm publish`, repositório remoto ou disparo do Pages sem aval do dono. Não rode `npm run setup:hooks` enquanto a pasta estiver dentro de outro repositório Git.
- **Falha real vira nota.** Registre em `docs/incidents/notes.md`, com data, sintoma e causa. Nunca invente.

## Como acrescentar uma ação ao catálogo

1. **Teste primeiro.** Em `tests/unit/autonomy.unit.test.ts`, afirme a faixa, os parâmetros válidos e os inválidos. Em `tests/unit/simulated-infra.unit.test.ts`, afirme o dry run, a execução e a reversão.
2. **Catálogo.** Acrescente a entrada em `EXECUTABLE_ACTIONS` (`src/domain/autonomy/catalog.ts`): faixa 2 ou 3, `mitigates`, `reversible`, `durationSec`, `targetKind`, `paramsSchema` estrito, `targetPattern`, `paramsText` e `description`. Ação proibida vai para `FORBIDDEN_ACTIONS`, nunca para `EXECUTABLE_ACTIONS`.
3. **Executor.** Implemente o executor em `EXECUTORS` (`src/infra/simulated-infra.ts`). O registro é `Record<ExecutableActionType, Executor>`, então o typecheck falha até ele existir.
4. **Regra do auditor**, se a ação precisar de evidência: `src/domain/audit/auditor-rules.ts`, com teste.
5. **Regenerar.** Rode `npm run regen`, que atualiza `docs/autonomy-matrix.md` e os golden, e revise o diff. O catálogo entra no prompt do planejador como entrada, não no `system`: o hash da fixture não muda.
6. **Verificar.** Rode `npm run typecheck && npm test`.
