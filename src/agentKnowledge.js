const { pool } = require('./db');
const { generateEmbedding } = require('./embeddings');

/**
 * Busca semântica sobre a base de conhecimento do Agente de IA
 * (chunks gerados por src/knowledgeDocs.js) — consumida por
 * src/agent.js ao montar o contexto de uma resposta.
 */

// Acha os N chunks mais relevantes pra uma pergunta/mensagem do lead,
// via distância de cosseno (<=> do pgvector, menor = mais parecido;
// `1 - distância` vira "similaridade", mais intuitivo de exibir/logar
// que uma distância crua). `topK` pequeno de propósito (contexto pro
// prompt, não uma listagem completa — mesmo cuidado de custo/latência
// já documentado nos limites de INSIGHT_MAX_* de src/openai.js).
// Devolve [] (nunca lança) se a instância não tiver nenhum chunk
// ainda — busca sem resultado é um estado normal, não um erro.
async function searchRelevantChunks(sessionId, queryText, topK = 5) {
  const trimmed = String(queryText || '').trim();
  if (!trimmed) return [];

  const embedding = await generateEmbedding(trimmed);
  const vectorParam = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `select content, 1 - (embedding <=> $1::vector) as similarity
     from agent_knowledge_chunks
     where session_id = $2
     order by embedding <=> $1::vector
     limit $3`,
    [vectorParam, sessionId, topK]
  );
  return rows;
}

module.exports = { searchRelevantChunks };
