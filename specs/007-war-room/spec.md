# 007: War Room lite

Marco M7. Estado: implementado.

## Contexto

Quem avalia o projeto tem dois minutos e talvez não rode nada. A War Room é uma página estática, publicável no GitHub Pages, que reproduz execuções gravadas pelo próprio backend:

- a conversa entre agentes;
- o portão de aprovação, com os ramos aprovar e rejeitar;
- os números;
- o post-mortem.

Ela deixa claro, em todas as telas, que é reprodução com provedor fake. Como as gravações carregam saída do backend, este marco também prova que nenhum segredo sai do processo por nenhuma das 7 superfícies.

## Escopo

- `DemoRecorder` (`recordScenario` e `recordAll`, em `src/app/demo-recorder.ts`) e CLI `record-demo`. Gravam os 2 cenários com relógio e ids determinísticos, com prefixo comum e dois ramos, validadas por `DemoRecordingSchema`. São geradas no build e não versionadas.
- Teste de segredos nas 7 superfícies: HTTP, MCP, trace, auditoria, logs, relatórios e gravações.
- Pacote `web/` aninhado, sem workspace: React 19, Vite 8, Vitest 5 e jsdom.
  - Design tokens em `tokens.css`, temas claro e escuro.
  - `check:tokens` falha com cor literal fora de `tokens.css`.
  - Teste de contraste dos pares declarados.
- Replay (`replay-engine.ts`) com pausa no portão e escolha de ramo. Fonte demo que só busca `./demo/` e valida por Zod.
- 9 componentes acessíveis:
  - `ModeBanner`, `ScenarioPicker`, `PlaybackControls`;
  - `AgentConversation`;
  - `ApprovalGate`, `ApprovalDialog`, `TierBadge`;
  - `MetricsCards`, `PostmortemView`.
- `.github/workflows/pages.yml`, só com disparo manual.

## Non-goals

- Modo ao vivo contra a API local, `SettingsDialog` e campo de token (backlog v2).
- `Tabs`, `Sparkline`, tabela de trace filtrável e teste de `prefers-reduced-motion` (backlog v2).
- Testes de navegador real (Playwright ou Cypress).
- Internacionalização: interface em pt-BR.
- Cálculo de métricas no navegador: a War Room só mostra o que a gravação traz.

## Critérios de aceite (EARS)

- **AC-17** O sistema nunca deve incluir o valor de `APPROVAL_TOKEN` ou de `OPENROUTER_API_KEY` em respostas HTTP, saídas MCP, trace, auditoria, logs, relatórios ou gravações de demo, mesmo quando o valor for enviado num campo de texto.
- **AC-39** Enquanto estiver em modo demo, a War Room deve mostrar em todas as telas o rótulo "Reprodução de execução gravada com provedor fake roteirizado", buscar apenas arquivos de `./demo/`, recusar com erro explícito gravação que não passe no `DemoRecordingSchema`, prender o foco no diálogo de aprovação (ESC fecha e devolve o foco), comunicar a faixa por texto e ícone além da cor, e usar pares de cor com contraste mínimo de 4,5:1.

Verificação manual, sem critério automatizado: abaixo de 600 px a War Room usa uma coluna, sem rolagem horizontal, e tudo é operável por teclado. O registro fica em `docs/accessibility.md`.

## Como verificar

| Critério | Testes |
|---|---|
| AC-17 | `tests/e2e/secrets.e2e.test.ts` ("no secret value appears in any output surface"); `tests/unit/redact.unit.test.ts` |
| AC-39 | `tests/e2e/demo-recordings.e2e.test.ts`; `web/src/test/demo-source.test.ts`; `web/src/test/replay-engine.test.ts`; `web/src/test/ApprovalDialog.test.tsx`; `web/src/test/components.test.tsx` (axe); `web/src/test/tokens-contrast.test.ts`; `web/src/test/App.test.tsx` |

Marco demonstrável: `npm run web:demo` mostra os 2 cenários com aprovar e rejeitar; `VITE_BASE=/incident-copilot/ npm run web:build` gera o site com as gravações em `web/dist/demo`.

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "6.6 Segredos e redação";
- "7.6 Artefatos gerados";
- "10.2 O que a demo da War Room mostra";
- "8.3 Critérios de aceite em EARS".

Evidências de acessibilidade em `docs/accessibility.md`.
