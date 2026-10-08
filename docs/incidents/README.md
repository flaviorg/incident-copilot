# Post-mortems da construção

Esta pasta guarda falhas **reais** enfrentadas durante a construção do projeto, escritas como post-mortems sem culpa. Nada aqui é inventado. A matéria-prima é `notes.md`, onde cada falha foi anotada no dia, com sintoma e causa, enquanto o trabalho acontecia.

| Nº | Título | Área |
|---|---|---|
| [0001](0001-fake-consumia-roteiro-por-processo.md) | O provedor fake consumia o roteiro por processo, e o 2º incidente da API respondia 500 | Provedor fake, API e MCP |
| [0002](0002-foco-perdido-no-portao.md) | O foco do teclado se perdia no portão de aprovação da War Room | Acessibilidade da War Room |

As demais falhas de `notes.md` foram menores e ficaram só como nota:

- teste de herança do `recursionLimit` com topologia errada;
- nó do grafo com nome de chave do estado;
- modo estrito olhando todos os cenários;
- caso de dry run falho que não passava pelo auditor;
- ordem da reversão conferida pelo campo errado;
- CSS vazio no Vitest;
- comando de limpeza com glob que o zsh recusa;
- cabeçalho do npm no stdout de `npm run mcp`;
- aviso de script de instalação do `fsevents` ausente das notas de API;
- decisão aceita durante a execução de abertura, achada na revisão final;
- `check:secrets` varrendo o `.env` local, achado na revisão final.

## Como escrever um post-mortem

- **Sem culpa.** O texto descreve sistemas, suposições e sinais, não pessoas. A pergunta é "o que deixou isso possível?", não "quem errou?".
- **Só fatos.** O que não foi medido nem registrado fica de fora ou aparece como "não registrado". Horários entram só se foram anotados.
- **Ação com dono e prova.** Cada ação diz o que mudou e qual teste impede a volta do problema.
- **Curto.** Uma página basta.

## Template

Copie o bloco abaixo para `NNNN-<slug>.md`, com o próximo número livre.

```markdown
# NNNN: <título curto, no passado, descrevendo o efeito>

- **Data:** AAAA-MM-DD
- **Área:** <componente ou camada>
- **Severidade:** <baixa | média | alta> (<por quê, em uma frase>)
- **Status:** <resolvido | mitigado | em aberto>

## Resumo

Duas ou três frases: o que aconteceu, quem seria afetado e como terminou.

## Impacto

Quem ou o que foi afetado, por quanto tempo e em que condições. Se nada chegou a quem usa (falha pega antes de publicar), diga isso e diga quem *teria* sido afetado.

## Linha do tempo

Eventos em ordem, do primeiro sinal à correção verificada. Use horários só se foram registrados.

1. ...

## Causa

A causa técnica e a suposição que a tornou possível. Por que os testes ou as revisões existentes não pegaram.

## O que funcionou

Sinais, testes, ferramentas ou práticas que ajudaram a detectar, entender ou corrigir.

## O que não funcionou

O que atrasou a detecção ou confundiu o diagnóstico.

## Ações

| Ação | Tipo | Prova |
|---|---|---|
| ... | correção, prevenção ou detecção | teste ou verificação que impede a volta |

## Lições

Uma ou duas frases que valem para outros projetos.
```
