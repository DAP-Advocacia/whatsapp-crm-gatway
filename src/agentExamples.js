const { pool } = require('./db');
const { generateEmbedding } = require('./embeddings');

/**
 * Exemplos few-shot aprovados do Agente de IA (agent_examples) — só
 * texto JÁ anonimizado e revisado por um humano (ver
 * src/exampleApproval.js). Espelha src/agentKnowledge.js ponto a
 * ponto: mesmo contrato de busca semântica (nunca lança, [] quando
 * não há nada ainda), mesmo estilo de query.
 */

// topK menor que o de chunks (5) porque um exemplo de conversa é bem
// mais longo que um chunk de 2000 caracteres — ajustável sem mudança
// estrutural.
async function searchRelevantExamples(sessionId, queryText, topK = 3) {
  const trimmed = String(queryText || '').trim();
  if (!trimmed) return [];

  const embedding = await generateEmbedding(trimmed);
  const vectorParam = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `select id, anonymized_text as text, 1 - (embedding <=> $1::vector) as similarity
     from agent_examples
     where session_id = $2
     order by embedding <=> $1::vector
     limit $3`,
    [vectorParam, sessionId, topK]
  );
  return rows;
}

async function listApproved(sessionId) {
  const { rows } = await pool.query(
    `select id, anonymized_text as "anonymizedText", approved_by as "approvedBy",
            approved_by_name as "approvedByName", created_at as "createdAt"
     from agent_examples where session_id = $1 order by created_at desc`,
    [sessionId]
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

// Devolve true/false (removeu ou não achou) — mesmo contrato de
// deleteDoc em src/knowledgeDocs.js, pra a rota decidir 404.
async function remove(sessionId, exampleId) {
  const { rowCount } = await pool.query(
    `delete from agent_examples where id = $1 and session_id = $2`,
    [exampleId, sessionId]
  );
  return rowCount > 0;
}

module.exports = { searchRelevantExamples, listApproved, remove };
