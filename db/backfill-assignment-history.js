// Cria um período de histórico "em aberto" (ended_at = null) pra toda
// conversa que já tem conversations.assigned_to preenchido mas nenhuma
// linha em conversation_assignment_history — atribuições feitas ANTES da
// Parte CI (Painel de atendimento) existir nunca geraram histórico, então
// ficavam invisíveis pro Painel até a próxima troca/liberação (ver
// HANDOFF.md, Parte CI).
//
// `started_at = conversations.created_at` (não "agora") — de propósito:
// com "agora", mensagens recentes que já existiam ANTES do backfill rodar
// ficavam fora da janela do período (bug real, encontrado testando: uma
// conversa com mensagem pendente às 14:25 sumiu do Painel porque o
// primeiro backfill criou o período às 14:31, depois da mensagem).
// Usando created_at da conversa, cobre TODO o histórico de mensagens já
// trocadas com essa atribuição, não só o que vier a partir de agora.
// Idempotente: só cria histórico pra quem ainda não tem nenhum
// (`not exists`), pode rodar mais de uma vez sem duplicar.
require('dotenv').config();
const { pool } = require('../src/db');

async function main() {
  const { rows } = await pool.query(
    `select c.id, c.session_id, c.phone, c.assigned_to, c.assigned_to_name, c.created_at as "startedAt", i.owner_id as "ownerId"
     from conversations c
     left join instances i on i.id = c.session_id
     where c.assigned_to is not null
       and not exists (
         select 1 from conversation_assignment_history h where h.conversation_id = c.id
       )`
  );

  if (!rows.length) {
    console.log('[backfill-assignment-history] nenhuma conversa atribuída sem histórico — nada a fazer.');
    return;
  }

  console.log(`[backfill-assignment-history] ${rows.length} conversa(s) atribuída(s) sem histórico — criando período em aberto...`);
  for (const row of rows) {
    const ownerId = row.ownerId || row.session_id; // mesmo fallback usado em outras partes do código quando a instância não tem registro próprio
    await pool.query(
      `insert into conversation_assignment_history (conversation_id, owner_id, assigned_to, assigned_to_name, started_at)
       values ($1, $2, $3, $4, $5)`,
      [row.id, ownerId, row.assigned_to, row.assigned_to_name, row.startedAt]
    );
    console.log(`  - conversa ${row.id} (${row.session_id} / ${row.phone}) -> ${row.assigned_to_name || row.assigned_to}, desde ${row.startedAt.toISOString()}`);
  }
  console.log(`[backfill-assignment-history] ${rows.length} período(s) criado(s) com sucesso.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-assignment-history] falhou:', err.message);
    process.exit(1);
  });
