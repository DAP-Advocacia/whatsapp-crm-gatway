const express = require('express');
const { requireSession } = require('../authz');
const agentConfigStore = require('../agentConfig');
const knowledgeDocs = require('../knowledgeDocs');
const store = require('../store');
const exampleCandidates = require('../exampleCandidates');
const exampleApproval = require('../exampleApproval');
const agentExamples = require('../agentExamples');

/**
 * Rotas do Agente de IA (tela public/agente-ia.html) — configuração
 * por instância, upload/listagem/remoção de documentos da base de
 * conhecimento, e o toggle manual "Desativar IA nesta conversa" (por
 * conversa, usado em public/chat.html). Todas atrás de requireAuth
 * (montado em src/server.js) + requireSession (posse da instância,
 * mesmo padrão de todas as outras rotas por `session`).
 */

const VALID_FILE_TYPES = ['pdf', 'docx', 'txt', 'md'];

function createAgentRouter() {
  const router = express.Router();

  router.get('/config', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json(await agentConfigStore.get(req.query.session));
    } catch (err) {
      console.error('[agent] erro ao ler config:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.put('/config', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, active, systemMessage, knowledgeText } = req.body || {};
    const patch = {};
    if ('active' in (req.body || {})) patch.active = active;
    if ('systemMessage' in (req.body || {})) patch.systemMessage = systemMessage;
    if ('knowledgeText' in (req.body || {})) patch.knowledgeText = knowledgeText;
    try {
      res.json(await agentConfigStore.upsert(session, patch));
    } catch (err) {
      console.error('[agent] erro ao salvar config:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /knowledge/upload  { session, fileName, fileType, dataBase64 }
  // Mesmo padrão base64 de POST /send-media (src/routes/whatsapp.js) —
  // decodifica no servidor, sem multer/multipart. Processamento
  // (extração + chunking + embeddings) roda SÍNCRONO dentro da própria
  // requisição — pode levar alguns segundos pra um documento grande,
  // mas evita a complexidade de um job assíncrono separado só pra isso
  // nesta v1; a UI mostra "processing" enquanto espera de qualquer
  // forma (o resultado final já vem pronto na resposta).
  // ---------------------------------------------------------------
  router.post('/knowledge/upload', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, fileName, fileType, dataBase64 } = req.body || {};
    if (!fileName || !fileType || !dataBase64) {
      return res.status(400).json({ error: 'fileName, fileType e dataBase64 são obrigatórios' });
    }
    if (!VALID_FILE_TYPES.includes(fileType)) {
      return res.status(400).json({ error: `fileType deve ser um de: ${VALID_FILE_TYPES.join(', ')}` });
    }
    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      const result = await knowledgeDocs.processUploadedDocument(session, { fileName, fileType, buffer });
      res.json(result);
    } catch (err) {
      console.error('[agent] erro ao processar documento:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/knowledge', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ docs: await knowledgeDocs.listDocs(req.query.session) });
    } catch (err) {
      console.error('[agent] erro ao listar documentos:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/knowledge/:docId', requireSession((req) => req.query.session), async (req, res) => {
    try {
      const deleted = await knowledgeDocs.deleteDoc(req.query.session, req.params.docId);
      if (!deleted) return res.status(404).json({ error: 'documento não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[agent] erro ao remover documento:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Botão manual "Desativar IA nesta conversa" (public/chat.html) —
  // única via de REATIVAR o agente numa conversa depois de desativado
  // (a auto-desativação por humano, ver POST /send em
  // src/routes/whatsapp.js, só desliga; ligar de novo sempre exige
  // essa ação explícita).
  router.post('/conversations/toggle', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, enabled } = req.body || {};
    if (!phone || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'phone e enabled (boolean) são obrigatórios' });
    }
    try {
      await store.setAgentEnabled(session, phone, enabled);
      res.json({ ok: true });
    } catch (err) {
      console.error('[agent] erro ao togglar conversa:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/conversations/status', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      res.json({ agentEnabled: await store.getAgentEnabled(session, phone) });
    } catch (err) {
      console.error('[agent] erro ao ler status:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Aprendizado por exemplos (few-shot) — fila de candidatas marcadas
  // manualmente no Chat (botão "Marcar como exemplo"), revisadas e
  // aprovadas/rejeitadas em public/agent-examples.html. `markedBy`/
  // `reviewedBy`/`approvedBy` são SEMPRE req.ownerId (nunca vindo do
  // client) — só o *Name (resolvido no frontend via BX24
  // user.current, mesmo padrão de ownerName em POST
  // /presence/heartbeat) vem do body.
  // ---------------------------------------------------------------
  router.post('/examples/candidates', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, contactName, transcriptRaw, markedByName } = req.body || {};
    if (!phone || !transcriptRaw) {
      return res.status(400).json({ error: 'phone e transcriptRaw são obrigatórios' });
    }
    try {
      const candidate = await exampleCandidates.create(session, {
        phone, contactName, transcriptRaw, markedBy: req.ownerId, markedByName,
      });
      res.json(candidate);
    } catch (err) {
      console.error('[agent] erro ao criar candidata a exemplo:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/examples/candidates', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ candidates: await exampleCandidates.list(req.query.session, req.query.status) });
    } catch (err) {
      console.error('[agent] erro ao listar candidatas:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/examples/candidates/:id/reject', requireSession((req) => req.body?.session), async (req, res) => {
    const { session } = req.body || {};
    try {
      const rejected = await exampleCandidates.markRejected(session, req.params.id, {
        reviewedBy: req.ownerId, reviewedByName: req.body?.reviewedByName,
      });
      if (!rejected) return res.status(404).json({ error: 'candidata não encontrada ou já revisada' });
      res.json(rejected);
    } catch (err) {
      console.error('[agent] erro ao rejeitar candidata:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Passo 1 do fluxo de aprovação: roda a anonimização (regex + IA +
  // reverificação), grava o rascunho, devolve pra tela exibir/editar.
  // NUNCA cria agent_examples aqui — só o /confirm abaixo faz isso.
  router.post('/examples/candidates/:id/review', requireSession((req) => req.body?.session), async (req, res) => {
    const { session } = req.body || {};
    try {
      const result = await exampleApproval.reviewCandidate(session, req.params.id);
      if (result.status === 'not_found') return res.status(404).json({ error: 'candidata não encontrada ou já revisada' });
      res.json(result);
    } catch (err) {
      console.error('[agent] erro ao revisar candidata:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Passo 2: confirma definitivamente (com ou sem edição do texto do
  // passo 1) — reverifica o texto FINAL antes de gravar.
  router.post('/examples/candidates/:id/confirm', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, finalText, approvedByName } = req.body || {};
    if (!finalText) return res.status(400).json({ error: 'finalText é obrigatório' });
    try {
      const result = await exampleApproval.confirmApproval(session, req.params.id, finalText, {
        approvedBy: req.ownerId, approvedByName,
      });
      if (result.status === 'not_found') return res.status(404).json({ error: 'candidata não encontrada ou já revisada' });
      if (result.status === 'invalid' || result.status === 'rejected_by_check') {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      console.error('[agent] erro ao confirmar aprovação:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/examples', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ examples: await agentExamples.listApproved(req.query.session) });
    } catch (err) {
      console.error('[agent] erro ao listar exemplos:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/examples/:id', requireSession((req) => req.query.session), async (req, res) => {
    try {
      const deleted = await agentExamples.remove(req.query.session, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'exemplo não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[agent] erro ao remover exemplo:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAgentRouter };
