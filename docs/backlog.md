# Backlog (anotado em 2026-11-03)

## Prioridade alta (pedido do Gabriel)
1. **Mensagem não enviada (bolinha vermelha)**: hoje a mensagem só existe na tela e se perde ao recarregar.
   Guardar a tentativa e reenviar (botão "Reenviar" e/ou reenvio automático quando a sessão voltar online).
   Cuidado: timeout pode significar "enviou mas a resposta não voltou" (risco de duplicar).
2. **Botão "Sincronizar esta conversa"** dentro do chat (ressincroniza só aquele contato, sem fila grande).
   Base: `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` do Baileys (histórico sob demanda,
   o celular precisa estar online). Validar na versão 7.0.0-rc13 antes de prometer.
3. **Áudio/mídia de histórico com mais de 2 dias é descartado** (`HISTORY_MEDIA_MAX_AGE_DAYS=2`, e sem legenda a
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
