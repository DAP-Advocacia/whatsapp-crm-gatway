const { pool } = require('./db');
const candidates = require('./exampleCandidates');
const { anonymizeTranscript, findPiiLeaks } = require('./exampleAnonymizer');
const { generateEmbedding } = require('./embeddings');

/**
 * Orquestra o fluxo de 2 passos de aprovar uma candidata a exemplo
 * few-shot — nunca 1 passo só, porque a v1 tem edição manual
 * confirmada como requisito: o humano precisa poder REVISAR/EDITAR o
 * texto anonimizado antes de ele virar definitivo.
 *
 * Passo 1 (reviewCandidate): roda a anonimização, grava o rascunho,
 * devolve pra tela. NUNCA cria agent_examples aqui.
 * Passo 2 (confirmApproval): humano confirma (com ou sem edição) —
 * reverifica o texto FINAL antes de gravar (última rede de segurança
 * contra a própria edição humana reintroduzindo algo sensível), só
 * então grava embedding + linha em agent_examples.
 */

async function reviewCandidate(sessionId, candidateId) {
  const candidate = await candidates.get(sessionId, candidateId);
  if (!candidate || candidate.status !== 'pending_review') return { status: 'not_found' };

  const result = await anonymizeTranscript(candidate.transcriptRaw);
  if (result.status !== 'ok') {
    await candidates.markAnonymizationFailed(sessionId, candidateId, result.reason);
    return { status: 'anonymization_failed', error: result.reason };
  }

  await candidates.saveDraft(sessionId, candidateId, result.anonymizedText);
  return { status: 'ready_for_review', draft: result.anonymizedText };
}

async function confirmApproval(sessionId, candidateId, finalText, { approvedBy, approvedByName }) {
  const candidate = await candidates.get(sessionId, candidateId);
  if (!candidate || candidate.status !== 'pending_review') return { status: 'not_found' };

  const trimmed = String(finalText || '').trim();
  if (!trimmed) return { status: 'invalid', error: 'texto final não pode ser vazio' };

  // Última rede de segurança — reverifica o texto FINAL (já editado
  // ou não pelo humano), não o rascunho original do passo 1. Uma
  // edição manual pode reintroduzir algo sensível por acidente; isso
  // nunca é gravado silenciosamente.
  const leaks = findPiiLeaks(trimmed);
  if (leaks.length) {
    return { status: 'rejected_by_check', error: `ainda há dado sensível reconhecível: ${leaks.join(', ')}` };
  }

  const embedding = await generateEmbedding(trimmed);
  const vectorParam = `[${embedding.join(',')}]`;

  await pool.query('begin');
  try {
    await pool.query(
      `insert into agent_examples (session_id, candidate_id, anonymized_text, embedding, approved_by, approved_by_name)
       values ($1, $2, $3, $4::vector, $5, $6)`,
      [sessionId, candidateId, trimmed, vectorParam, approvedBy, approvedByName || null]
    );
    const updated = await candidates.markApproved(sessionId, candidateId, {
      reviewedBy: approvedBy, reviewedByName: approvedByName,
    });
    if (!updated) {
      // Corrida rara: outra requisição já aprovou/rejeitou essa
      // candidata entre o `get` do início e este ponto — desfaz o
      // insert acima pra não duplicar exemplo de uma candidata que
      // já não está mais pending_review.
      await pool.query('rollback');
      return { status: 'not_found' };
    }
    await pool.query('commit');
  } catch (err) {
    await pool.query('rollback');
    throw err; // falha de banco é diferente de falha de anonimização — propaga de verdade
  }

  return { status: 'approved' };
}

module.exports = { reviewCandidate, confirmApproval };
