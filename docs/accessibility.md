# Acessibilidade da War Room

A War Room (`web/`) é uma página estática que reproduz gravações. Este documento separa o que é provado por teste automático do que foi conferido à mão, com a data e o que foi observado. Itens não conferidos aparecem como pendência: nada aqui foi presumido.

## Provado por teste automático

| O que | Como | Teste |
|---|---|---|
| Nenhuma violação do axe na conversa, no portão, no diálogo e no post-mortem | `axe-core` 4.13 sobre o DOM renderizado no jsdom | `web/src/test/components.test.tsx` ("axe finds no violations in conversation, gate, dialog and postmortem") |
| Diálogo de aprovação: foco entra, fica preso, Escape fecha e devolve o foco | Testing Library com `user-event` (Tab, Shift+Tab, Escape) | `web/src/test/ApprovalDialog.test.tsx` ("moves focus in, traps it, closes on Escape and returns focus") |
| Diálogo tem nome, descrição e o aviso "Simulação local: nenhuma ação real" | `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby` | `ApprovalDialog.test.tsx` ("names itself, warns that nothing real runs and confirms the decision") |
| Faixa comunicada por texto e ícone, não só por cor | `TierBadge` escreve "Faixa N", com o rótulo da faixa no `title`; o ícone SVG é `aria-hidden` | `components.test.tsx` ("TierBadge communicates the tier by text") |
| Rótulo de modo demo literal em todas as telas | `ModeBanner` com `role="status"`, sempre montado pelo `App` | `components.test.tsx` ("ModeBanner shows the literal label"); `App.test.tsx` |
| Foco do teclado acompanha a ação | Ao carregar ou escolher o ramo, o foco vai para Avançar; no portão, para o título do portão; no fim, para o título do post-mortem | `web/src/test/App.test.tsx` ("keeps keyboard focus where the action is: step button, gate and postmortem") |
| Reprodução não começa sozinha | Sem autoplay; quem usa avança passo a passo ou aperta reproduzir | `replay-engine.test.ts` ("starts empty, without autoplay"); `components.test.tsx` |
| Contraste de pelo menos 4,5:1 nos pares declarados, nos temas claro e escuro | Cálculo de luminância relativa (WCAG 2.x) sobre os valores de `tokens.css`, para os 17 pares de `web/src/styles/contrast-pairs.json` | `web/src/test/tokens-contrast.test.ts` ("every declared pair reaches 4.5:1 in light and dark themes") |
| Nenhuma cor literal fora de `tokens.css` | Varredura das fontes da War Room | `npm run check:tokens`; `tests/unit/check-tokens.unit.test.ts` |

### Por que o contraste é provado por teste próprio

No jsdom, a regra `color-contrast` do axe não funciona: não há layout nem estilo computado. Por isso o teste de contraste lê os tokens direto do CSS (`tokens.css?raw`, com `test.css: true` no `vite.config.ts`) e calcula a razão de cada par declarado. Um par novo de texto e fundo precisa entrar em `contrast-pairs.json` para ficar coberto.

## Conferência manual

**Data:** 2026-10-04 (bloco 4, Tarefa 41).

**Ambiente:**

- servidor de desenvolvimento do Vite (`npm run web:demo`);
- painel de navegador do ambiente de desenvolvimento;
- gravações geradas por `npm run demo:record`.

**Método:** só teclado (Tab, Shift+Tab, Enter e Escape), sem mouse. Os dois cenários nos dois ramos, em duas larguras:

| Percurso | Largura |
|---|---|
| deploy aprovado | 1280 px |
| custo rejeitado | 375 px |
| deploy rejeitado | 375 px |
| custo aprovado | 1280 px |

### Checklist

- [x] **Operável só por teclado.** Seleção de cenário, Avançar, Aprovar, Rejeitar e o diálogo de confirmação funcionaram sem mouse nos quatro percursos, do começo ao post-mortem.
- [x] **375 px sem rolagem horizontal.** `scrollWidth` igual a `clientWidth`. Uma coluna de 343 px, sobrando 16 px de cada lado.
- [x] **Quebra de layout.** Uma coluna abaixo de 900 px e duas a partir daí: a 1280 px, duas colunas. O spec pede uma coluna abaixo de 600 px; a quebra em 900 px atende e dá folga a tablets.
- [x] **Diálogo.** Abre com o foco em Cancelar. Tab e Shift+Tab ficam presos no diálogo. Escape fecha e devolve o foco a Rejeitar.
- [x] **Rótulo da demo.** "Reprodução de execução gravada com provedor fake roteirizado" visível em todas as telas.
- [x] **Números do custo aprovado:**
  - US$ 339,59 de economia mensal;
  - MTTR de 19,9 min;
  - 18,0 min aguardando aprovação (soma das aprovações decididas).
- [x] **Console.** Nenhum erro.
- [x] **Defeito encontrado e corrigido.** O foco se perdia quando o botão Avançar ficava desabilitado (no portão e no fim) e ia para o `body`. A correção move o foco para o título do portão e para o título do post-mortem, e tem teste escrito antes dela. Post-mortem em `docs/incidents/0002-foco-perdido-no-portao.md`.
- [ ] **Leitor de tela.** Ainda não conferido com VoiceOver, NVDA ou outro leitor de tela. A estrutura tem regiões rotuladas (`aria-labelledby` em cada painel), `aria-live="polite"` no status da reprodução e `role="alert"` nos erros de carga. A experiência falada continua sem conferência.
- [ ] **Zoom de 200% e tema escuro do sistema.** O contraste do tema escuro é provado por teste, mas a leitura com zoom e com o tema escuro não foi conferida a olho.
- [ ] **Movimento reduzido.** `base.css` desliga transições com `prefers-reduced-motion: reduce`. Não há teste automático disso (item 4 do backlog v2).

### Reconferência com as gravações atuais

**Data:** 2026-10-04 (nova tentativa do bloco 4). As gravações mudaram depois da primeira conferência, então os quatro percursos foram refeitos só com teclado, nas mesmas larguras.

**Ambiente:** o build com a base do Pages (`VITE_BASE=/incident-copilot/ npm run web:build`), servido por `vite preview` com o mesmo `VITE_BASE`.

| Percurso | Largura | Fim da reprodução |
|---|---|---|
| deploy aprovado | 1280 px | evento 41 de 41, `resolvido`, MTTR 11,2 min, selo "narrativa validada pelo guarda numérico" |
| custo rejeitado | 375 px | evento 45 de 45, `escalado`, "mitigação rejeitada por humano", post-mortem parcial pelo template |
| deploy rejeitado | 375 px | evento 35 de 35, `escalado`, narrativa do template |
| custo aprovado | 1280 px | evento 53 de 53, `resolvido`, MTTR 19,9 min, 18,0 min aguardando aprovação, US$ 339,59 de economia mensal |

Os itens marcados no checklist acima se mantiveram nos quatro percursos:

- rótulo da demo visível;
- 375 px sem rolagem horizontal, numa coluna de 343 px;
- foco em Avançar ao carregar e depois da decisão, no título do portão ao parar e no título do post-mortem no fim;
- diálogo com foco inicial em Cancelar, Tab preso e Escape devolvendo o foco ao botão que o abriu;
- nenhum erro no console.

O `vite preview` precisa do mesmo `VITE_BASE` do build. Sem ele, o servidor devolve o `index.html` no lugar dos assets e o console mostra 404.

Os três itens desmarcados continuam pendentes.

## Como repetir a conferência

```bash
npm run web:install    # uma vez
npm run web:demo       # gera as gravações e sobe o Vite
```

No navegador, sem mouse: Tab até um cenário, Enter, Avançar até o portão, Tab até Aprovar ou Rejeitar, Enter, Tab até confirmar, Enter, e Avançar até o post-mortem. Repita a 375 px de largura (modo responsivo das ferramentas do navegador) e confira que não aparece barra de rolagem horizontal.
