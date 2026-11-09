# Arquitetura com workers de sessão

Criado em 2026-11-03, depois de medir em produção: 1 processo Node (2 CPUs, heap de ~2 GB) segurando
todas as sessões do WhatsApp saturava CPU, estourava memória a cada 1–2 h e derrubava todo mundo junto.
Meta: ~1.500 números.

## O desenho

```
                     ┌────────────────────────────────────────────┐
  Navegador/Bitrix ─▶│ PRINCIPAL (server.js)                      │
   HTTP + WebSocket  │  API, auth, banco, Bitrix, WebSocket do Chat│
                     │  RemoteSessionManager (espelho do estado)   │
                     └───────┬───────────────┬───────────────┬────┘
                          IPC│            IPC│            IPC│   (child_process.fork)
                     ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────┐
                     │ WORKER 0     │ │ WORKER 1     │ │ WORKER N-1   │
                     │ SessionManager│ │ SessionManager│ │ ...          │
                     │ + Baileys    │ │ + Baileys    │ │              │
                     │ ~1/N sessões │ │ ~1/N sessões │ │              │
                     └──────────────┘ └──────────────┘ └──────────────┘
                        pasta auth_session/ (compartilhada, cada worker usa só as suas)
```

- **Principal**: tudo que o app já fazia, exceto abrir sockets do Baileys. Recebe os eventos dos workers
  e roda os mesmos callbacks de antes (`onMessage`, `onStatus`...), então a lógica de negócio não mudou.
- **Worker**: o `SessionManager`/`WhatsAppGateway` de sempre, só com os eventos indo por IPC. É onde roda a
  parte pesada (criptografia Signal, histórico, reconexão). Cada um tem seu núcleo e seu heap.
- **Qual sessão vai pra qual worker**: `shardOf(sessionId, N)` (hash FNV-1a, `src/shard.js`). Estável enquanto
  N não muda. **Mudar N reembaralha as sessões** — faça com o serviço parado/de madrugada.
- **Queda de worker**: só o pedaço dele fica offline; o principal recria o worker (backoff 2s→60s) e as
  sessões voltam pela fila de pareamento. As outras sessões nem percebem.
- **Mesmo IP**: o ritmo de logins por worker é multiplicado por N (`staggerMs`/`pairingGapMs` × N), então o
  ritmo TOTAL de logins no IP continua o mesmo de um processo só.

## Como ligar

Sem nada configurado o app roda como antes (`SESSION_WORKERS=0`, tudo num processo).

| Variável | Padrão | O que faz |
|---|---|---|
| `SESSION_WORKERS` | `0` | Nº de workers. 0 = tudo no processo principal. |
| `WORKER_HEAP_MB` | `2048` | Limite de heap de CADA worker (sobrepõe `NODE_OPTIONS`). |
| `WORKER_DB_POOL_MAX` | `4` | Conexões de banco por worker. |
| `WORKER_CALL_TIMEOUT_MS` | `120000` | Tempo máximo de uma chamada (envio de mídia, grupo...). |
| `SESSION_BOOT_MODE` | `lazy` | `all` reconecta todas as sessões salvas no boot. **Produção usa `all` desde 2026-11-06** (ver `DEPLOY.md` 4.1). |
| `SESSION_STAGGER_MS` | `15000` | Intervalo entre sessões no boot completo (total, dividido entre workers). |
| `PAIRING_MIN_GAP_MS` | `5000` | Intervalo mínimo entre logins (total). |
| `LOGIN_GATE` | ligado | Trava global de logins (ver abaixo). `off` volta ao intervalo N vezes maior por worker. |
| `WORKER_RECYCLE` | ligado | Reciclagem de worker antes de estourar o heap (ver abaixo). `off` desliga. |
| `WORKER_RECYCLE_SOFT_MB` / `_HARD_MB` | 70% / 88% do heap | Limites de heap usado. Acima do 1º só recicla de madrugada; acima do 2º recicla a qualquer hora. |
| `WORKER_RECYCLE_HOUR_START` / `_END` | `2` / `5` | Janela da reciclagem (horário de Brasília, `[início, fim)`). |
| `WORKER_RECYCLE_GAP_MS` | `1500000` | Intervalo mínimo entre duas reciclagens (25 min; religar um worker leva ~18 min). |
| `WORKER_MEM_SAMPLE_MS` / `WORKER_MEM_LOG_EVERY` | `60000` / `5` | Amostra de memória de cada worker, e 1 linha de log a cada N amostras. |
| `AI_FEATURES` | desligado | `true` religa a IA (precisa de `OPENAI_API_KEY`). |

Sugestão para a KVM 4 (4 vCPU / 16 GB): `SESSION_WORKERS=2`, `WORKER_HEAP_MB=4096`,
`NODE_OPTIONS=--max-old-space-size=2048` (o principal não segura mais os sockets).
Para ~1.500 sessões: KVM 8 com `SESSION_WORKERS=4`, ou dois servidores (também dilui o risco de ban por IP).

## Trava global de logins (2026-11-09)

Antes, cada worker espaçava os próprios logins em `PAIRING_MIN_GAP_MS * N` (20 s com 4 workers). Isso só dava
5 s no total quando os 4 subiam juntos: com UM worker religando (queda ou reciclagem) o ritmo era 1 login a
cada 20 s, ~73 min para ~215 sessões. Agora cada login pede vaga ao processo principal (`loginReq`), que
libera uma por vez, na ordem de chegada, com no mínimo `PAIRING_MIN_GAP_MS` (5 s) entre dois logins de QUALQUER
worker (`loginGrant`). O ritmo total nunca passa de 1 login a cada 5 s; um worker sozinho usa o ritmo inteiro
(~18 min para 215 sessões). Pedido de worker que caiu não gasta vaga. Sem resposta em 3 min o worker segue
sozinho. As reconexões automáticas depois de uma queda de socket não passam pela fila (como antes).

## Telemetria e reciclagem de memória (2026-11-09)

Em 48 h de produção os 4 workers estouraram o heap de 7 GB 11 vezes (SIGABRT, ~20 h de uso cada), derrubando
~1/4 das sessões por vez. Cada worker manda ao principal, a cada minuto, o heap usado, rss, sessões e
tamanho dos caches em memória; 1 linha a cada 5 min vai pro log (`[worker N] memória: ...`), com o heap
por espaço (`old_space`, `large_object_space`...) pra mostrar o que cresce.

Quando o heap usado passa do limite por 3 amostras seguidas, o principal recicla o worker: desligamento limpo
(o mesmo do deploy: fecha os sockets sem deslogar e grava as credenciais), recriação em 2 s e as sessões
voltam pela trava de logins. Acima de `WORKER_RECYCLE_SOFT_MB` só dentro da janela da madrugada, um worker de
cada vez e com intervalo mínimo; acima de `WORKER_RECYCLE_HARD_MB` a qualquer hora (melhor que o crash). Sem
saída em 20 s, SIGKILL. O monitor de desconexões fica quieto, como em qualquer queda de worker.
Isto CONTÉM o problema, não o corrige: a causa do crescimento de memória ainda é desconhecida (ver o log).

## Testado e não testado

Testado localmente (sessões não pareadas, geração de QR): criação e distribuição entre workers, espelho
de estado síncrono, RPC com erro propagado, `kill -9` de um worker (só o pedaço dele cai e volta),
remoção de sessão. **Não testado com mensagens reais de WhatsApp** — por isso fica desligado por padrão:
ligue com poucas sessões primeiro e compare envio/recebimento antes de generalizar.

## Limites conhecidos (próximos passos)

1. O principal ainda grava no banco todas as mensagens (inclusive histórico). Se virar gargalo, mover a
   persistência para os workers.
2. As chaves de criptografia ainda são arquivos em `auth_session/` (3,5 mi de arquivos hoje). Para 1.500
   números o certo é guardar no Postgres (`useMultiFileAuthState` → store próprio).
3. Um IP só para todos os chips. Acima de ~1.000 sessões, avaliar dividir em 2 servidores (cada um com
   `SESSION_WORKERS` próprio e a sessão presa a um servidor).
4. `SESSION_WORKERS` > 0 num servidor com 2 vCPU não ajuda: use no mínimo `vCPU - 2` workers.
