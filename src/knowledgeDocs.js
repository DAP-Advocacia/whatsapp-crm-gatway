const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { pool } = require('./db');
const { saveMedia, deleteMedia } = require('./media');
const { generateEmbeddingsBatch } = require('./embeddings');

/**
 * Base de conhecimento do Agente de IA — parsing de arquivo (PDF/DOCX/
 * TXT/Markdown) + chunking + embeddings, por instância (session_id).
 * Ver db/schema.sql (agent_knowledge_docs/agent_knowledge_chunks) e
 * src/agentKnowledge.js (busca por similaridade, consumidor dos chunks
 * gerados aqui).
 */

const MIMETYPE_BY_FILE_TYPE = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/plain', // sem mimetype próprio no mapa de src/media.js — trata como texto puro
};

// Extrai texto puro do buffer conforme o tipo. Lança com mensagem
// amigável se não conseguir extrair nada (ex: PDF escaneado como
// imagem, sem texto real, ou arquivo corrompido) — quem chama
// (processUploadedDocument) decide marcar o documento como 'error'.
async function extractText(buffer, fileType) {
  if (fileType === 'txt' || fileType === 'md') {
    const text = buffer.toString('utf-8').trim();
    if (!text) throw new Error('o arquivo está vazio');
    return text;
  }

  if (fileType === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      // pdf-parse (v2) adiciona um rodapé "-- N of M --" por página —
      // ruído que não deve entrar na base de conhecimento.
      const cleaned = result.text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();
      if (!cleaned) throw new Error('não foi possível extrair texto deste PDF (pode ser um PDF escaneado, sem texto real)');
      return cleaned;
    } finally {
      await parser.destroy();
    }
  }

  if (fileType === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || '').trim();
    if (!text) throw new Error('não foi possível extrair texto deste DOCX');
    return text;
  }

  throw new Error(`tipo de arquivo não suportado: ${fileType}`);
}

// Divide o texto em chunks de tamanho razoável pro embedding.
// Heurística por CARACTERES (não tokens reais — evita depender de um
// tokenizer específico só pra isso, mesmo custo/precisão aceitável já
// que o teto de tokens do prompt final tem folga, ver src/agent.js).
// ~500 tokens ≈ ~2000 caracteres em português; overlap pequeno (200
// chars) pra não cortar uma frase relevante bem na fronteira entre 2
// chunks consecutivos.
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

function splitIntoChunks(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= CHUNK_SIZE) return [normalized];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

// Orquestra: insere doc como 'processing' -> extrai texto -> chunka ->
// gera embeddings em lote -> insere chunks -> marca doc 'ready' (ou
// 'error' com error_message em qualquer falha no meio do caminho —
// nunca deixa doc preso em 'processing' pra sempre). Salva o arquivo
// original no Storage (best-effort, reaproveitando saveMedia — se
// falhar, não impede a extração/busca, só perde a possibilidade de
// reprocessar o binário original depois).
async function processUploadedDocument(sessionId, { fileName, fileType, buffer }) {
  const { rows } = await pool.query(
    `insert into agent_knowledge_docs (session_id, file_name, file_type, status)
     values ($1, $2, $3, 'processing')
     returning id`,
    [sessionId, fileName, fileType]
  );
  const docId = rows[0].id;

  try {
    const content = await extractText(buffer, fileType);

    let storagePath = null;
    try {
      const mimetype = MIMETYPE_BY_FILE_TYPE[fileType];
      storagePath = await saveMedia(sessionId, `kb_${docId}`, buffer, mimetype);
    } catch (err) {
      console.error(`[knowledge-docs] falha ao salvar arquivo original no Storage (doc ${docId}, seguindo sem isso):`, err.message);
    }

    const chunkTexts = splitIntoChunks(content);
    const embeddings = await generateEmbeddingsBatch(chunkTexts);

    await pool.query('begin');
    try {
      for (let i = 0; i < chunkTexts.length; i++) {
        await pool.query(
          `insert into agent_knowledge_chunks (doc_id, session_id, chunk_index, content, embedding)
           values ($1, $2, $3, $4, $5::vector)`,
          [docId, sessionId, i, chunkTexts[i], `[${embeddings[i].join(',')}]`]
        );
      }
      await pool.query(
        `update agent_knowledge_docs set content = $1, storage_path = $2, status = 'ready' where id = $3`,
        [content, storagePath, docId]
      );
      await pool.query('commit');
    } catch (err) {
      await pool.query('rollback');
      throw err;
    }

    return { docId, status: 'ready', chunkCount: chunkTexts.length };
  } catch (err) {
    await pool.query(
      `update agent_knowledge_docs set status = 'error', error_message = $1 where id = $2`,
      [err.message, docId]
    );
    return { docId, status: 'error', error: err.message };
  }
}

async function listDocs(sessionId) {
  const { rows } = await pool.query(
    `select id, file_name as "fileName", file_type as "fileType", status, error_message as "errorMessage",
            created_at as "createdAt"
     from agent_knowledge_docs where session_id = $1 order by created_at desc`,
    [sessionId]
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

async function deleteDoc(sessionId, docId) {
  const { rows } = await pool.query(
    `select storage_path as "storagePath" from agent_knowledge_docs where id = $1 and session_id = $2`,
    [docId, sessionId]
  );
  if (!rows[0]) return false;

  // cascade apaga os chunks junto (FK on delete cascade, ver schema)
  const { rowCount } = await pool.query(
    `delete from agent_knowledge_docs where id = $1 and session_id = $2`,
    [docId, sessionId]
  );

  // best-effort — o registro já foi removido do banco de qualquer
  // forma; um arquivo órfão no Storage é um resíduo tolerável, nunca
  // motivo pra falhar a remoção do documento em si.
  if (rows[0].storagePath) {
    await deleteMedia(rows[0].storagePath).catch((err) =>
      console.error(`[knowledge-docs] falha ao remover arquivo do Storage (doc ${docId}):`, err.message)
    );
  }

  return rowCount > 0;
}

module.exports = { extractText, splitIntoChunks, processUploadedDocument, listDocs, deleteDoc };
