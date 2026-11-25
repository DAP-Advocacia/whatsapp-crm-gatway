# Backlog (anotado em 2026-11-03)

## Decisões do Gabriel (2026-11-03)
- Reenvio de mensagem que falhou: botão **e** reenvio automático (FEITO só para texto; mídia/áudio ainda não).
- Mídia de histórico: manter 2 dias; **continuar puxando ao rolar a conversa pra cima** (pedir ao celular via fetchMessageHistory; junto com o botão de sincronizar).
- Instância criada e nunca conectada: apagar ao sair da tela de configuração; plano B 12 h (só nunca pareadas, nunca as que têm conversa).
- Boot das sessões: SESSION_BOOT_MODE=all (depois do upgrade da VPS).
- Workers: esperar até testar com contas reais.
- Lista do gestor: "Instância principal — Maria".

## Prioridade alta (pedido do Gabriel)
1. **Mensagem não enviada (bolinha vermelha)**: hoje a mensagem só existe na tela e se perde ao recarregar.
   Guardar a tentativa e reenviar (botão "Reenviar" e/ou reenvio automático quando a sessão voltar online).
   Cuidado: timeout pode significar "enviou mas a resposta não voltou" (risco de duplicar).
2. **Botão "Sincronizar esta conversa"** dentro do chat (ressincroniza só aquele contato, sem fila grande).
   Base: `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` do Baileys (histórico sob demanda,
   o celular precisa estar online). Validar na versão 7.0.0-rc13 antes de prometer.
3. (FEITO) **Áudio/mídia de histórico com mais de 2 dias é descartado** (`HISTORY_MEDIA_MAX_AGE_DAYS=2`, e sem legenda a
   mensagem inteira é descartada). Causa provável do caso "só a saudação apareceu, áudios sumiram".
   Mínimo: salvar um marcador `[áudio]` em vez de descartar.
4. **Mensagens enviadas pelo celular com o gateway offline** chegam como `type='append'` e o handler de
   `messages.upsert` ignora tudo que não é `notify`. Avaliar processar `append` como histórico.

## Tela de conexão (QR)
5. Barra de progresso do QR continua andando sem tentativa de conexão: parar quando não há QR ativo.
6. Falha na conexão: aviso na frente do QR com "clique aqui para gerar outro QR".
7. Sucesso: aviso "conectado" + botão para ir ao Chat.
8. Instância criada e nunca conectada: apagar sozinha depois de um prazo (definir prazo; só as nunca pareadas).

## Compartilhamento
9. Gestor com várias pessoas: na lista de instâncias que ele pode ver, mostrar também o nome do colaborador
   dono (hoje aparece só o nome da instância, ex. "Instância principal").

## Infra
10. Chaves de criptografia em Postgres em vez de 3,5 mi de arquivos.
11. (FEITO) `SESSION_WORKERS` ligado em produção (6 workers, heap 4096; ver docs/arquitetura-workers.md).
12. `stop_grace_period` de 10 s para 30–60 s.
13. Aviso no Chat de sessão desconectada/desatualizada; levantar quantas pessoas estão assim.
14. Rotacionar a senha do banco (apareceu em saída de terminal em 2026-11-03).

## Quedas de 10 e 11/11 (acompanhar; detalhes em docs/arquitetura-workers.md)
15. (FEITO 25/11, `d34a290`) 8 workers de 3072 MB, `SOFT_MB=2150`, `HARD_MB=2400`, `CONFIRM=2`, `SAMPLE_MS=15000` e diagnóstico de heap (`mem-wN.log`, `heap-wN-*.txt`).
    Próximo: ler `/tmp/node-reports` depois do primeiro pico de manhã (26/11) para achar o que enche o heap.
    Cada deploy recomeça o boot (~75 min com ~900 sessões): nunca em horário comercial.
16. **Medir depois do deploy**: mortes de worker por dia útil, `loop p99/max` e `event loop travou`, relatório de OOM em `/tmp/node-reports`, steal de CPU, 401 por hora.
17. **Estouro de heap em minutos** (615 MB a 4 GB): causa desconhecida; usar o relatório do próximo `--report-on-fatalerror`.
    Ideia: reciclar também por atraso do event loop (p99 alto), já que um worker travado nem manda amostra de memória.
18. **401 em massa depois da morte de um worker** (95 de 106 em 11/11, nos 2 workers que morreram): hipótese não provada de chaves Signal gravadas atrás da memória na morte brusca.
19. **Repareamento**: ~350 sessões offline são 401/403 e só voltam com QR (nenhuma está "reconectando"). Levantar por gestor no `/painel`. Do chamado de 10/11: Bianca (4 números), André Contato 1, Yuri VENDAS 2.0.
20. **Banco**: automações de leitura (`leitura_claude`, `supabase_read_only_user`, a do Bruno com `right(c.phone,N)` sem filtro de período) são as maiores leitoras de disco; levar para fora do horário comercial.
21. **Servidor**: Elder pedir à Hostinger troca de nó (steal médio diário de 4–14 %, picos de 47 %, sem padrão de horário; Elder só abre chamado com OK do Gabriel; perguntar à Hostinger se o IP se mantém e combinar janela fora do horário comercial). Reavaliar a migração em 7 dias (critério em `docs/migracao-aws.md`).
22. **Swarm `start-first`**: durante o deploy 2 containers ficam ~6 s com a mesma pasta de credenciais. Não vi 440, mas é o risco já documentado; avaliar `stop-first` junto com o item 12.

## Lista de transmissão (/campaign.html, 11/11)
23. **Fila persistente**: o envio roda em memória no processo principal (`src/campaigns.js`). Deploy ou reinício no meio interrompe a lista e o agendamento fica em `sending` para sempre. Fazer antes de subir `CAMPAIGN_MAX_RECIPIENTS` (padrão 100) ou de usar intervalos longos com listas grandes: destinatários e versões em tabela, retomada no boot.
24. **SQL antes do deploy** (avulso, com `set lock_timeout='3s'`; sem ele só a lista com várias versões agendada falha): `alter table scheduled_campaigns add column if not exists templates jsonb;`
25. Ideias: gerar versões da mensagem com IA (`src/openai.js`); contar envios por versão nas métricas (hoje só fica em memória, em `results[].variant`).
26. **Acesso**: só o super admin cria/agenda lista de transmissão (`CAMPAIGN_ADMIN_ONLY`, padrão ligado; `=0` libera pra todos). O admin dispara, agenda e vê agenda/métricas pela instância de outra pessoa (`requireSessionOrAdmin`, `src/authz.js`; só nas rotas de campanha, o chat e as conversas seguem só do dono). Fica no `action_log` ("pela instância X"). O dono da instância não é avisado e vê as mensagens na conversa dele.
27. **Instância offline no meio da lista**: o envio pausa e retoma sozinho quando ela volta (`CAMPAIGN_OFFLINE_MAX_WAIT_MS`, padrão 30 min); passou disso, os contatos que faltam ficam "não enviados" (sem tentativa de envio, dá para refazer só com eles). Visto em produção em 11/11: 503 do WhatsApp derrubou 9 sessões em 37 s durante o boot e a lista marcou 3 contatos como falha. Não cobre reinício do servidor (item 23).

## Patch combinado para 26/11 (aprovado, ainda não feito)
23. **Bloqueio de deslogadas**: tirar `loggedOut`/`needsAttention` da fila automática; carregar em lote com `listOpenAttentionEvents()` (`instanceHealthStore.js`) antes do boot; liberar se o evento fechou ou se o `creds.json` é mais novo que o evento.
24. **Leituras sem efeito**: `GET /instances` e `/status` não podem disparar login nem QR.
25. **"Tentar reconectar"**: `POST /instances/:id/reconnect` não pode dar 404; criar o espelho da sessão e chamar `retryManually()`.
26. **Histórico**: logar entrada e conclusão de cada lote (worker, sessão, `syncType`, quantidade, fila, idade).
27. **Reciclagem**: checar o limite duro independente do leve (`remoteSessions.js`).
28. **Testes**: reinício de um worker e do serviço inteiro com conta válida, conta 401 e conta nunca pareada.
29. **Transmissão**: rota e botão de cancelar; voltar `CAMPAIGN_MAX_RECIPIENTS` para 100.
