const express = require('express');
const contacts = require('../contacts');
const templates = require('../templates');
const { parseContactsCsv } = require('../csvImport');
const { requireSession } = require('../authz');

const MAX_CSV_ROWS = 5000;

/**
 * Rotas de "CRM próprio" do gateway: contatos, listas de contatos e modelos
 * de mensagem — tudo o que dá suporte à página de Campanha (public/campaign.html)
 * e à página de Contatos (public/contacts.html). Montado em /api, atrás do
 * middleware requireAuth (ver server.js) — req.ownerId já é a identidade
 * real do usuário Bitrix.
 *
 * Contatos e listas são escopados por req.ownerId direto (não por sessão de
 * WhatsApp) — ver db/schema.sql: um dono pode ter várias instâncias, e os
 * contatos precisam continuar aparecendo mesmo que a instância que os criou
 * caia e uma nova seja conectada. A SQL em src/contacts.js já filtra por
 * owner_id, então nenhum client pode ler/editar contato de outro usuário.
 *
 * Modelos de mensagem continuam por sessão de propósito (cada instância tem
 * os próprios) — mantêm requireSession normalmente.
 */
function createCrmRouter() {
  const router = express.Router();

  // ---------------- Contatos ----------------

  router.get('/contacts', async (req, res) => {
    try {
      res.json({ contacts: await contacts.listContacts(req.ownerId) });
    } catch (err) {
      console.error('[contacts] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/contacts', async (req, res) => {
    const { name, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const clean = String(phone).replace(/\D/g, '');
      if (!clean) return res.status(400).json({ error: 'phone inválido' });
      res.json(await contacts.upsertContact(req.ownerId, { name, phone: clean }));
    } catch (err) {
      console.error('[contacts] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.put('/contacts/:id', async (req, res) => {
    const { name, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const clean = String(phone).replace(/\D/g, '');
      if (!clean) return res.status(400).json({ error: 'phone inválido' });
      const updated = await contacts.updateContact(req.params.id, req.ownerId, { name, phone: clean });
      if (!updated) return res.status(404).json({ error: 'contato não encontrado' });
      res.json(updated);
    } catch (err) {
      console.error('[contacts] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/contacts/:id', async (req, res) => {
    try {
      const deleted = await contacts.deleteContact(req.params.id, req.ownerId);
      if (!deleted) return res.status(404).json({ error: 'contato não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[contacts] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/contacts/import-conversations', async (req, res) => {
    try {
      await contacts.importFromConversations(req.ownerId);
      res.json({ ok: true, contacts: await contacts.listContacts(req.ownerId) });
    } catch (err) {
      console.error('[contacts:import] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Importa contatos de um arquivo CSV (nome + telefone por linha) — body
  // { csvText } já decodificado como texto no client (FileReader.readAsText,
  // não precisa de base64 já que CSV é texto puro). Só CSV por enquanto, não
  // .xlsx — ver o comentário no topo de src/csvImport.js sobre por quê.
  router.post('/contacts/import-csv', async (req, res) => {
    const { csvText } = req.body || {};
    if (!csvText || !csvText.trim()) return res.status(400).json({ error: 'csvText é obrigatório' });
    try {
      const { contacts: rows, totalRows, skipped } = parseContactsCsv(csvText);
      if (totalRows > MAX_CSV_ROWS) {
        return res.status(400).json({ error: `máximo de ${MAX_CSV_ROWS} linhas por arquivo` });
      }
      const imported = await contacts.importRows(req.ownerId, rows);
      res.json({ ok: true, imported, skipped, contacts: await contacts.listContacts(req.ownerId) });
    } catch (err) {
      console.error('[contacts:import-csv] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ---------------- Listas de contatos ----------------

  router.get('/contact-lists', async (req, res) => {
    try {
      res.json({ lists: await contacts.listContactLists(req.ownerId) });
    } catch (err) {
      console.error('[contact-lists] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/contact-lists/:id', async (req, res) => {
    try {
      const list = await contacts.getContactList(req.params.id, req.ownerId);
      if (!list) return res.status(404).json({ error: 'lista não encontrada' });
      res.json(list);
    } catch (err) {
      console.error('[contact-lists] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/contact-lists', async (req, res) => {
    const { name, contactIds } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name é obrigatório' });
    }
    try {
      const id = await contacts.createContactList(req.ownerId, name.trim(), contactIds || []);
      res.json({ ok: true, id });
    } catch (err) {
      console.error('[contact-lists] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.put('/contact-lists/:id', async (req, res) => {
    const { name, contactIds } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    try {
      const updated = await contacts.updateContactList(req.params.id, req.ownerId, name.trim(), contactIds || []);
      if (!updated) return res.status(404).json({ error: 'lista não encontrada' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[contact-lists] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/contact-lists/:id', async (req, res) => {
    try {
      const deleted = await contacts.deleteContactList(req.params.id, req.ownerId);
      if (!deleted) return res.status(404).json({ error: 'lista não encontrada' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[contact-lists] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------- Modelos de mensagem ----------------

  router.get('/templates', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ templates: await templates.listTemplates(req.query.session) });
    } catch (err) {
      console.error('[templates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/templates', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, name, body } = req.body || {};
    if (!name || !name.trim() || !body || !body.trim()) {
      return res.status(400).json({ error: 'name e body são obrigatórios' });
    }
    try {
      res.json(await templates.createTemplate(session, name.trim(), body));
    } catch (err) {
      console.error('[templates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.put('/templates/:id', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, name, body } = req.body || {};
    if (!name || !name.trim() || !body || !body.trim()) {
      return res.status(400).json({ error: 'name e body são obrigatórios' });
    }
    try {
      const updated = await templates.updateTemplate(req.params.id, session, name.trim(), body);
      if (!updated) return res.status(404).json({ error: 'modelo não encontrado' });
      res.json(updated);
    } catch (err) {
      console.error('[templates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/templates/:id', requireSession((req) => req.query.session), async (req, res) => {
    try {
      const deleted = await templates.deleteTemplate(req.params.id, req.query.session);
      if (!deleted) return res.status(404).json({ error: 'modelo não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[templates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createCrmRouter };
