const express = require('express');
const { requireSession } = require('../authz');
const agentConfigStore = require('../agentConfig');
const knowledgeDocs = require('../knowledgeDocs');
const store = require('../store');

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

  return router;
}

module.exports = { createAgentRouter };
