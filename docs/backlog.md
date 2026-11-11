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
11. Ligar `SESSION_WORKERS` depois de testar com contas reais (ver docs/arquitetura-workers.md).
12. `stop_grace_period` de 10 s para 30–60 s.
13. Aviso no Chat de sessão desconectada/desatualizada; levantar quantas pessoas estão assim.
14. Rotacionar a senha do banco (apareceu em saída de terminal em 2026-11-03).

## Lista de transmissão (/campaign.html, 11/11)
23. **Fila persistente**: o envio roda em memória no processo principal (`src/campaigns.js`). Deploy ou reinício no meio interrompe a lista e o agendamento fica em `sending` para sempre. Fazer antes de subir `CAMPAIGN_MAX_RECIPIENTS` (padrão 100) ou de usar intervalos longos com listas grandes: destinatários e versões em tabela, retomada no boot.
24. **SQL antes do deploy** (avulso, com `set lock_timeout='3s'`; sem ele só a lista com várias versões agendada falha): `alter table scheduled_campaigns add column if not exists templates jsonb;`
25. Ideias: gerar versões da mensagem com IA (`src/openai.js`); contar envios por versão nas métricas (hoje só fica em memória, em `results[].variant`).
26. **Acesso**: só o super admin cria/agenda lista de transmissão (`CAMPAIGN_ADMIN_ONLY`, padrão ligado; `=0` libera pra todos). O admin dispara, agenda e vê agenda/métricas pela instância de outra pessoa (`requireSessionOrAdmin`, `src/authz.js`; só nas rotas de campanha, o chat e as conversas seguem só do dono). Fica no `action_log` ("pela instância X"). O dono da instância não é avisado e vê as mensagens na conversa dele.
