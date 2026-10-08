# Constitution do incident-copilot

Princípios inegociáveis. Toda spec em `specs/NNN-*/spec.md`, todo plano e toda mudança de código seguem este arquivo. Mudar um princípio exige registrar o motivo aqui, no mesmo commit.

## 1. A tese

**O modelo propõe; o código e o humano decidem.**

- O LLM escolhe o próximo especialista, investiga, monta o plano, pede revisão e redige.
- Código determinístico:
  - classifica o risco;
  - decide o que roda sozinho;
  - impõe o piso de qualidade do plano;
  - guarda a aprovação;
  - calcula os números;
  - grava a auditoria.
- Nenhuma garantia de segurança depende do texto de um prompt.

## 2. Regra de dependência

- `src/contracts` e `src/domain` não importam `node:*` nem `infra`, `llm`, `graph`, `app`, `http`, `mcp` ou `cli`. Um teste confere.
- `graph` recebe as dependências por fábrica; das camadas de fora, importa tipos e só os utilitários de formatação do trace. Cada nó recebe só o que usa. Nós de ação não recebem LLM.
- As portas (`http`, `mcp`, `cli`) falam com `app`. Enums do SQL são gerados dos enums Zod.

## 3. Testes

- TDD: o teste falha primeiro, depois vem a implementação mínima, depois o verde.
- `npm test` nunca usa rede nem chave real. `fetch` é bloqueado no processo de teste e nos filhos.
- Nenhum teste compara texto livre de LLM por igualdade; testes afirmam estrutura, enums, estado e números.
- O provedor fake é roteirizado e estrito: chamada sem turno quebra o teste. Fixture muda junto com prompt.

## 4. Segredos

- `APPROVAL_TOKEN` e `OPENROUTER_API_KEY` nunca são ecoados: não aparecem em resposta HTTP, saída MCP, trace, auditoria, log, relatório nem gravação.
- Todo texto que sai do processo passa por `redactSecrets`.
- `check:secrets` roda no pre-commit e no CI.

## 5. Faixa 4 por construção

- A faixa vem do catálogo e de regras que só sobem. A saída do LLM não tem campo de faixa.
- Ação proibida ou desconhecida não tem executor (o tipo não existe), não tem dry run nem fila, e é auditada.
- A trilha de auditoria é só de inserção, com gatilhos no banco e hash encadeado.

## 6. Nada publicado sem validação humana

- Nenhum `git push`, `npm publish`, repositório remoto ou deploy sem o aval explícito do dono do projeto.
- O workflow do Pages só roda por disparo manual. `npm run setup:hooks` só depois de a pasta ter Git próprio.

## 7. Idiomas

- Código, tipos, colunas, campos e nomes de teste em inglês (`tier`, `TierSchema`, `TierBadge`).
- Texto para pessoas em pt-BR: CLI, War Room, mensagens de erro, README e docs. "Faixa" só em texto.

## 8. Dependências

- Versões exatas no `package.json`. Toda dependência nova exige justificativa escrita na spec ou no plano: o que resolve e por que o que já existe não basta.
- Antes de usar uma biblioteca pela primeira vez, a API real é conferida nos `.d.ts` e registrada em `docs/api-notes.md`.

## 9. Material do curso

- Aulas citadas só por ID e tema.
- Nenhum trecho de transcrição, slide ou material autoral no repositório. Dados, nomes, mensagens e preços são próprios.
