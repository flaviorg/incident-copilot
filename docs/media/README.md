# Mídia do README

| Arquivo | O que mostra | Tamanho |
|---|---|---|
| `docs/media/demo.gif` | Cerca de 15 segundos (25 quadros) da War Room no cenário de deploy: escolha do cenário, conversa entre agentes, portão de aprovação, clique em Aprovar, diálogo de confirmação e cartões de números (MTTR de 11,2 min e 3,0 min aguardando aprovação) | 960 × 1200 px, cerca de 410 KB (alvo: até 3 MB, de 960 a 1280 px de largura) |
| `docs/media/war-room.png` | A War Room parada no portão de aprovação do cenário `cost-anomaly`: três passos de faixa 3 aguardando decisão e o `delete_backups` de faixa 4 bloqueado sem dry run | 1280 × 1484 px, cerca de 380 KB (alvo: até 500 KB, 1280 px de largura) |

Os dois mostram a reprodução gravada com provedor fake, e o rótulo "Reprodução de execução gravada com provedor fake roteirizado" aparece no topo de todos os quadros.

## Como foram feitas

Em 2026-10-04, a partir do build real da War Room (`npm run web:build`, que regrava `web/public/demo` com `demo:record`):

1. `web/dist` servido em `127.0.0.1` por um servidor estático local, sem rede externa.
2. Um Chromium em modo headless (perfil temporário, apagado no fim), controlado pelo protocolo DevTools: tema claro, movimento reduzido, viewport de 1280 px.
3. **Captura:** cenário de custo, Avançar até o portão, recorte do topo da página até o fim do painel do portão.
4. **GIF:** viewport de 1280 × 1600 sem rolagem (o rótulo de modo demo fica sempre no quadro), um quadro a cada dois eventos, reduzido a 960 px de largura. Roteiro: cartão "Taxa de 5xx acima de 5% no orders-api", Avançar até o portão, Aprovar, Confirmar, Avançar até o fim. Os quadros viraram GIF com o ImageIO do macOS, com o tempo de cada quadro (0,3 s por passo; mais tempo na escolha do cenário, no portão, no diálogo e nos números).

O script de captura não faz parte do projeto, porque depende do navegador instalado na máquina. Qualquer gravação manual que siga o roteiro abaixo serve.

## Como regravar

1. Gere as gravações e suba a War Room:

   ```bash
   npm run web:install   # só na primeira vez
   npm run web:demo
   ```

2. Abra o endereço que o Vite mostrar (normalmente `http://localhost:5173`) numa janela de 1280 px de largura. Use o tema claro, que é o que o README assume.
3. **GIF.** Grave a tela com a ferramenta que preferir: no macOS, Cmd+Shift+5 grava um `.mov`.
   - Roteiro: clique no cartão "Taxa de 5xx acima de 5% no orders-api", avance até o portão, clique em Aprovar, confirme no diálogo e avance até os números.
   - Converta para GIF com 10 a 12 quadros por segundo. Por exemplo, com `ffmpeg` instalado:

     ```bash
     ffmpeg -i gravacao.mov -vf "fps=12,scale=1280:-1:flags=lanczos" -loop 0 docs/media/demo.gif
     ```

4. **Captura.** No cenário de custo, avance até o portão e capture a janela (no macOS, Cmd+Shift+4 e depois Espaço). Salve como `docs/media/war-room.png`.
5. Confira o tamanho dos dois arquivos contra a tabela acima e rode `npm run check:secrets`: as gravações da War Room não carregam segredos, mas a conferência é barata.

## O que não fazer

- Não grave a War Room com dados de um modelo real apresentando-os como demo: a demo publicada é sempre a reprodução do fake.
- Não edite o GIF para esconder o rótulo de modo demo.

## Depois de publicar

O README já aponta para o repositório público `flaviorg/incident-copilot`: o badge de CI usa `https://github.com/flaviorg/incident-copilot/actions/workflows/ci.yml/badge.svg?branch=main`, e a demo ao vivo fica em `https://flaviorg.github.io/incident-copilot/`. O badge só fica verde depois do primeiro push e do primeiro CI aprovado, e o endereço do Pages só responde depois de disparar à mão o workflow "Pages (War Room)". Se a War Room mudar de aparência, regrave o GIF e a captura.
