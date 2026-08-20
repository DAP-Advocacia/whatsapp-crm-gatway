const express = require('express');
const store = require('../store');
const { requireSession } = require('../authz');

const MAX_TEXT_LENGTH = 2000;

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

  return router;
}

module.exports = { createInternalNotesRouter };
