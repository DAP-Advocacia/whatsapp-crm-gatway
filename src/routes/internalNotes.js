const express = require('express');
const store = require('../store');
const { requireSession, requireResourceOwner } = require('../authz');

const MAX_TEXT_LENGTH = 2000;

// Dono (autor) de uma nota por id — usado por requireResourceOwner (ver
// src/authz.js, mesmo padrão de notificationOwner em routes/whatsapp.js)
// pra impedir editar/concluir nota de outra pessoa. Leitura (GET /)
// continua liberada a qualquer um com acesso à conversa, sem essa
// restrição — só editar/concluir exige ser o autor original.
async function noteAuthorOwner(req) {
  return store.getInternalNoteAuthorOwner(req.params.id);
}

/**
 * Nota interna — mensagem visível SÓ para internos (Responsável,
 * Verificação, atendente), NUNCA para o cliente, mesmo estando todos no
 * mesmo grupo de WhatsApp (feature "Criar grupo" do card, ver
 * src/routes/cardGroup.js). Serve tanto conversa 1-a-1 quanto
 * grupo-com-cliente igualmente — é a MESMA peça de infraestrutura pedida
 * antes (HANDOFF Parte DW: insight de IA em tempo real + nota do gerente
 * pro atendente), tratada aqui como uma coisa só, não duas.
 *
 * Montado em /api/internal-notes, atrás de requireAuth (ver server.js).
 * Router PRÓPRIO (não dentro de cardGroup.js) — nota interna não é
 * exclusiva do fluxo de grupo, existe também numa conversa 1-a-1 comum.
 *
 * NUNCA lida pelas rotas normais de histórico/envio (GET /history,
 * POST /send em routes/whatsapp.js) — tabela própria (internal_notes,
 * ver db/schema.sql), pra nunca vazar por engano no mesmo payload que
 * alimenta a bolha de conversa real nem ser confundida com envio de
 * verdade ao WhatsApp.
 */
function createInternalNotesRouter({ broadcast }) {
  const router = express.Router();

  // GET /?session=&phone=
  // Só leitura — se a conversa ainda não existe (nenhuma mensagem/nota
  // trocada ainda), devolve lista vazia sem criar uma conversation nova
  // à toa.
  router.get('/', requireSession((req) => req.query.session), async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const notes = await store.listInternalNotes(req.query.session, phone);
      res.json({ notes });
    } catch (err) {
      console.error('[internalNotes] erro ao listar:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /  { session, phone, text, authorName? }
  // author_owner_id é SEMPRE req.ownerId (nunca do client) — mesma regra
  // de sent_by em POST /send (routes/whatsapp.js): evita alguém se
  // declarar autor de uma nota que não escreveu. authorName é best-effort,
  // só pra exibição (vindo do client, igual senderName em POST /send).
  router.post('/', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, text, authorName } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    const trimmed = String(text || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'text é obrigatório' });
    if (trimmed.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `text não pode ter mais que ${MAX_TEXT_LENGTH} caracteres` });
    }

    try {
      const note = await store.addInternalNote(session, phone, {
        text: trimmed,
        authorOwnerId: req.ownerId,
        authorName: authorName || null,
      });
      // Broadcast pra outra aba da mesma conversa ver a nota chegar em
      // tempo real, mesmo mecanismo já usado por mensagem real
      // (type: 'message') — type distinto ('internal-note') pra quem
      // escuta no client nunca confundir os dois payloads.
      broadcast(session, phone, { type: 'internal-note', note });
      res.json({ ok: true, note });
    } catch (err) {
      console.error('[internalNotes] erro ao criar nota:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // PUT /:id  { session, phone, text }
  // Edita o texto, preservando a versão anterior em
  // internal_note_revisions (ver store.editInternalNote) — nunca
  // "sobrescreve e pronto" (pedido do usuário, 2026-08-25). Só o AUTOR
  // original pode editar (requireResourceOwner abaixo) — qualquer outro
  // com acesso à conversa continua podendo ler via GET /, sem essa
  // restrição.
  router.put('/:id', requireResourceOwner(noteAuthorOwner), async (req, res) => {
    const { session, phone, text } = req.body || {};
    if (!session) return res.status(400).json({ error: 'session é obrigatório' });
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    const trimmed = String(text || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'text é obrigatório' });
    if (trimmed.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `text não pode ter mais que ${MAX_TEXT_LENGTH} caracteres` });
    }

    try {
      const note = await store.editInternalNote(req.params.id, { text: trimmed, editedBy: req.ownerId });
      if (!note) return res.status(404).json({ error: 'nota não encontrada' });
      // Mesmo type de evento que a conclusão abaixo ('internal-note-updated')
      // — do ponto de vista do client, os dois casos são "esta nota mudou,
      // substitua pelo objeto novo"; não precisa de um 3º type só pra isso.
      broadcast(session, phone, { type: 'internal-note-updated', note });
      res.json({ ok: true, note });
    } catch (err) {
      console.error('[internalNotes] erro ao editar nota:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /:id/complete  { session, phone, completed }
  // Marca/desmarca como concluída (toggle explícito, permite reabrir —
  // mesmo padrão de POST /notifications/:id/read). Nota concluída
  // continua na MESMA posição cronológica do feed (decisão do usuário)
  // — esta rota nunca move nem apaga a nota, só marca o estado. Só o
  // autor original pode concluir/reabrir, mesma regra de PUT /:id acima.
  router.post('/:id/complete', requireResourceOwner(noteAuthorOwner), async (req, res) => {
    const { session, phone, completed } = req.body || {};
    if (!session) return res.status(400).json({ error: 'session é obrigatório' });
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

    try {
      const note = await store.setInternalNoteCompleted(req.params.id, {
        completed: !!completed,
        completedBy: req.ownerId,
      });
      if (!note) return res.status(404).json({ error: 'nota não encontrada' });
      broadcast(session, phone, { type: 'internal-note-updated', note });
      res.json({ ok: true, note });
    } catch (err) {
      console.error('[internalNotes] erro ao atualizar conclusão:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /:id/revisions?session=&phone=
  // Histórico de versões substituídas de uma nota — LEITURA, sem
  // requireResourceOwner (ler o histórico de uma nota que já se pode ler
  // via GET / não deveria ser mais restrito que a própria nota). Usa
  // session/phone como query params + requireSession, mesmo padrão de
  // GET / — session/phone aqui servem só pra confirmar posse da
  // instância (nunca são usados pra filtrar a query em si, que já é só
  // por :id).
  router.get('/:id/revisions', requireSession((req) => req.query.session), async (req, res) => {
    try {
      const revisions = await store.listInternalNoteRevisions(req.params.id);
      res.json({ revisions });
    } catch (err) {
      console.error('[internalNotes] erro ao listar histórico:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createInternalNotesRouter };
