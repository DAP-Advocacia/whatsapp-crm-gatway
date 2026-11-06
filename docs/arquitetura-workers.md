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
| `AI_FEATURES` | desligado | `true` religa a IA (precisa de `OPENAI_API_KEY`). |

Sugestão para a KVM 4 (4 vCPU / 16 GB): `SESSION_WORKERS=2`, `WORKER_HEAP_MB=4096`,
`NODE_OPTIONS=--max-old-space-size=2048` (o principal não segura mais os sockets).
Para ~1.500 sessões: KVM 8 com `SESSION_WORKERS=4`, ou dois servidores (também dilui o risco de ban por IP).

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
