# 0002: O foco do teclado se perdia no portão de aprovação da War Room

- **Data:** 2026-10-04
- **Área:** War Room (`web/src/App.tsx`), acessibilidade por teclado
- **Severidade:** média. Quem navega só por teclado ou com leitor de tela perdia o lugar exatamente no momento de decidir. Foi pega antes de qualquer publicação.
- **Status:** resolvido

## Resumo

Na conferência manual só com teclado, o foco ia para o `body` quando a reprodução chegava ao portão de aprovação. O botão Avançar, que estava focado, fica desabilitado nesse ponto. O mesmo acontecia no fim da reprodução. A correção move o foco para o título do portão e para o título do post-mortem, e mantém o foco em Avançar ao carregar uma gravação ou escolher um ramo.

## Impacto

- **Nada chegou a quem usa:** a War Room não tinha sido publicada.
- **Quem seria afetado:** qualquer pessoa que usasse a War Room por teclado ou com leitor de tela.
- **O que aconteceria:** ao chegar ao portão, ela perderia o lugar na página e teria de voltar ao começo com Tab para achar Aprovar e Rejeitar. No fim, aconteceria o mesmo antes do post-mortem.
- **Fora do alcance:** com mouse, nada mudava.

## Linha do tempo

Tudo em 2026-10-04, durante a Tarefa 41 (App, build e Pages). Horários não foram registrados.

1. Os testes automáticos da War Room passam: componentes, axe sem violações, diálogo com foco preso e fluxo completo do `App` nos dois ramos.
2. Começa a conferência manual pedida pelo plano: os dois cenários nos dois ramos, só com Tab, Shift+Tab, Enter e Escape, a 1280 px e a 375 px.
3. A 1280 px, ao chegar ao portão pelo botão Avançar, o foco vai para o `body`, e o próximo Tab recomeça do topo da página.
4. A causa é identificada: um botão que fica `disabled` enquanto focado perde o foco, e nenhum código o move. O mesmo acontece no fim da reprodução.
5. Um teste novo em `web/src/test/App.test.tsx` é escrito e visto falhando: depois do último Avançar antes do portão, o elemento ativo deveria ser o título do portão.
6. A correção entra em `App.tsx` e o teste fica verde.

## Causa

O `PlaybackControls` desabilita Avançar e Reproduzir quando a reprodução para no portão ou termina, o que está certo: não há próximo passo. O navegador tira o foco de um elemento que fica desabilitado, e o `App` não tinha nenhuma regra sobre para onde o foco deveria ir depois disso.

Os testes automáticos não pegaram por dois motivos:

- `user-event` clica nos botões pela referência e não depende de onde o foco está;
- o axe confere estrutura e nomes acessíveis, não o percurso do foco ao longo do tempo.

## O que funcionou

- **A conferência manual só com teclado,** prevista no plano como etapa obrigatória e não opcional. Foi ela que achou o defeito, e não os testes automáticos.
- **Títulos com id estável.** O portão (`gate-title`) e o post-mortem (`postmortem-title`) já tinham títulos com id e `aria-labelledby`, o que deu destinos naturais para o foco.

## O que não funcionou

- O teste de fluxo completo do `App` verificava conteúdo e ramos, mas nunca perguntava "onde está o foco agora?".

## Ações

| Ação | Tipo | Prova |
|---|---|---|
| Foco em Avançar ao carregar e ao escolher o ramo; no título do portão ao parar; no título do post-mortem ao terminar | correção | `App.test.tsx` ("keeps keyboard focus where the action is: step button, gate and postmortem"), escrito antes da correção |
| Checklist manual de teclado em `docs/accessibility.md`, com a data e o que foi observado | detecção | revisão a cada mudança na War Room |

## Lições

Botão que se desabilita sozinho é um ponto de perda de foco. Toda mudança de estado que desabilita o elemento focado precisa dizer para onde o foco vai, e um teste deve conferir `document.activeElement`, não só o conteúdo da tela.
