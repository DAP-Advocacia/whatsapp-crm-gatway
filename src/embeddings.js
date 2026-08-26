/**
 * Cliente mínimo pra Embeddings da OpenAI — usado pela base de
 * conhecimento do Agente de IA (src/knowledgeDocs.js, chunking de
 * documento; src/agentKnowledge.js, busca por similaridade). Mesmo
 * estilo de src/openai.js: fetch cru, sem SDK, modelo fixo (nunca
 * configurável pelo usuário — mudar de modelo de embedding exigiria
 * migrar a coluna `vector(1536)` de agent_knowledge_chunks).
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dimensões — ver db/schema.sql

async function _callEmbeddingsApi(input) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no servidor');
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || 'erro na API de Embeddings da OpenAI');
  }
  return data.data; // [{ index, embedding: number[] }, ...] — ordem preservada
}

// Gera o embedding de UM texto — devolve um array de 1536 floats,
// pronto pra INSERT/comparação com pgvector (o driver `pg` recebe o
// vetor como string "[0.1,0.2,...]" no bind, ver uso em
// src/agentKnowledge.js).
async function generateEmbedding(text) {
  const result = await _callEmbeddingsApi(text);
  return result[0].embedding;
}

// Em lote (usado ao processar um documento novo — um chunk por vez
// seria N round-trips desnecessários). A API aceita um array de
// strings em `input` numa chamada só, devolve os vetores na MESMA
// ordem em que os textos foram mandados (confirmado pelo campo
// `index` de cada item, usado aqui só pra garantir a ordem mesmo que
// a API algum dia devolva fora de ordem).
async function generateEmbeddingsBatch(texts) {
  if (!texts.length) return [];
  const result = await _callEmbeddingsApi(texts);
  return result
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

module.exports = { generateEmbedding, generateEmbeddingsBatch };
