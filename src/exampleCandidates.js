const { pool } = require('./db');

/**
 * Fila de candidatas a exemplo few-shot do Agente de IA — CRUD +
 * máquina de estados, mesmo padrão exato de src/suggestions.js: toda
 * transição é um `update ... where id=$1 and status='<esperado>'
 * returning ...`, nunca incondicional. Garante idempotência (clicar
 * 2x em "Rejeitar" não causa efeito colateral duplo) e devolve `null`
 * quando a transição não é válida a partir do estado atual — quem
 * chama decide o que fazer (404, ignorar).
 *
 * Estados: 'pending_review' -> 'approved' | 'rejected' |
 * 'anonymization_failed'. Ver db/schema.sql pro desenho completo.
 */

const COLUMNS = `
  id, session_id as "sessionId", phone, contact_name as "contactName",
  transcript_raw as "transcriptRaw", status, anonymized_draft as "anonymizedDraft",
  anonymization_error as "anonymizationError", marked_by as "markedBy",
  marked_by_name as "markedByName", reviewed_by as "reviewedBy",
  reviewed_by_name as "reviewedByName", reviewed_at as "reviewedAt",
  created_at as "createdAt"
`;

function serialize(row) {
  if (!row) return row;
  return {
    ...row,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function create(sessionId, { phone, contactName, transcriptRaw, markedBy, markedByName }) {
  const { rows } = await pool.query(
    `insert into agent_example_candidates (session_id, phone, contact_name, transcript_raw, marked_by, marked_by_name)
     values ($1, $2, $3, $4, $5, $6)
     returning ${COLUMNS}`,
    [sessionId, phone, contactName || null, transcriptRaw, markedBy, markedByName || null]
  );
  return serialize(rows[0]);
}

// `status` opcional filtra a listagem (ex: só 'pending_review' pra
// fila de revisão); sem filtro, lista tudo — mais recente primeiro.
async function list(sessionId, status) {
  const { rows } = status
    ? await pool.query(
        `select ${COLUMNS} from agent_example_candidates where session_id = $1 and status = $2 order by created_at desc`,
        [sessionId, status]
      )
    : await pool.query(
        `select ${COLUMNS} from agent_example_candidates where session_id = $1 order by created_at desc`,
        [sessionId]
      );
  return rows.map(serialize);
}

async function get(sessionId, candidateId) {
  const { rows } = await pool.query(
    `select ${COLUMNS} from agent_example_candidates where id = $1 and session_id = $2`,
    [candidateId, sessionId]
  );
  return serialize(rows[0]) || null;
}

// Grava o rascunho anonimizado (passo 1 do fluxo de aprovação) — não
// muda o status, só cacheia o resultado pro humano poder sair e
// voltar à tela sem perder o que já foi gerado.
async function saveDraft(sessionId, candidateId, anonymizedDraft) {
  const { rows } = await pool.query(
    `update agent_example_candidates set anonymized_draft = $3
     where id = $1 and session_id = $2 and status = 'pending_review'
     returning ${COLUMNS}`,
    [candidateId, sessionId, anonymizedDraft]
  );
  return serialize(rows[0]) || null;
}

async function markRejected(sessionId, candidateId, { reviewedBy, reviewedByName }) {
  const { rows } = await pool.query(
    `update agent_example_candidates set status = 'rejected', reviewed_by = $3, reviewed_by_name = $4, reviewed_at = now()
     where id = $1 and session_id = $2 and status = 'pending_review'
     returning ${COLUMNS}`,
    [candidateId, sessionId, reviewedBy, reviewedByName || null]
  );
  return serialize(rows[0]) || null;
}

async function markAnonymizationFailed(sessionId, candidateId, errorMessage) {
  const { rows } = await pool.query(
    `update agent_example_candidates set status = 'anonymization_failed', anonymization_error = $3
     where id = $1 and session_id = $2 and status = 'pending_review'
     returning ${COLUMNS}`,
    [candidateId, sessionId, errorMessage]
  );
  return serialize(rows[0]) || null;
}

async function markApproved(sessionId, candidateId, { reviewedBy, reviewedByName }) {
  const { rows } = await pool.query(
    `update agent_example_candidates set status = 'approved', reviewed_by = $3, reviewed_by_name = $4, reviewed_at = now()
     where id = $1 and session_id = $2 and status = 'pending_review'
     returning ${COLUMNS}`,
    [candidateId, sessionId, reviewedBy, reviewedByName || null]
  );
  return serialize(rows[0]) || null;
}

module.exports = { create, list, get, saveDraft, markRejected, markAnonymizationFailed, markApproved };
