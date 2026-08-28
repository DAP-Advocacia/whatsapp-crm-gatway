const { pool } = require('./db');
const { generateEmbedding } = require('./embeddings');

/**
 * Few-shot do Dapinho (dapinho_examples) — espelha src/agentExamples.js
 * ponto a ponto (mesmo contrato de busca semântica, nunca lança, [] quando
 * não há nada ainda), mas por OWNER, não por sessão/instância — o Dapinho é
 * uma conversa por dono, não por WhatsApp conectado. Diferente do Agente de
 * IA, aqui não existe fluxo de aprovação/anonimização manual: é o próprio
 * dono conversando sobre os próprios dados, então toda interação real já
 * nasce reutilizável (ver src/dapinho.js, quem grava aqui logo após
 * responder).
 */

async function saveExample(ownerId, question, answer) {
  try {
    const embedding = await generateEmbedding(question);
    const vectorParam = `[${embedding.join(',')}]`;
    await pool.query(
      `insert into dapinho_examples (owner_id, question, answer, embedding) values ($1, $2, $3, $4::vector)`,
      [ownerId, question, answer, vectorParam]
    );
  } catch (err) {
    // Best-effort — nunca deve derrubar a resposta já dada ao usuário só
    // porque o registro de few-shot falhou (mesmo espírito de todo canal
    // best-effort já existente no projeto, ver src/alertDispatcher.js).
    console.error('[dapinho] falha ao salvar exemplo few-shot (seguindo sem isso):', err.message);
  }
}

async function searchRelevantExamples(ownerId, queryText, topK = 3) {
  const trimmed = String(queryText || '').trim();
  if (!trimmed) return [];

  const embedding = await generateEmbedding(trimmed);
  const vectorParam = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `select id, question, answer, 1 - (embedding <=> $1::vector) as similarity
     from dapinho_examples
     where owner_id = $2
     order by embedding <=> $1::vector
     limit $3`,
    [vectorParam, ownerId, topK]
  );
  return rows;
}

module.exports = { saveExample, searchRelevantExamples };
