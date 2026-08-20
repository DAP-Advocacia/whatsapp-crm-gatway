const express = require('express');
const store = require('../store');
const actionLog = require('../actionLog');
const { requireSession } = require('../authz');
const { bitrixUserIdFromOwnerId } = require('../auth');
const { getEmployeeInfo } = require('../bitrixHierarchy');
const { callBitrix } = require('../bitrix');
const { resolveCustomFieldName, getVerificationResponsibleUserId } = require('../bitrixDealFields');

// Celular do Bitrix costuma vir SEM o código do país (DDD + número, 10-11
// dígitos) — mesmo critério já usado em src/routes/suggestions.js.
function normalizeBrazilPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

/**
 * "Criar grupo" a partir do card do negócio (aba DapZap, ver public/index.html)
 * — monta um grupo de WhatsApp real reunindo o Responsável do negócio, a
 * pessoa do campo customizado "[AUT] Resp. Ver. Contratos" e quem está
 * logado clicando no botão, além do cliente (telefone já resolvido pela
 * própria tela). Montado em /api/card-group, atrás de requireAuth (ver
 * server.js).
 *
 * Diferente de POST /groups (src/routes/whatsapp.js, tela Contatos/Chat,
 * "grupo em comum") — grupos criados aqui são marcados com
 * wa_groups.source='card' e wa_groups.deal_id, o que os torna os ÚNICOS
 * grupos cujas mensagens recebidas são processadas/salvas (ver bypass em
 * src/whatsapp.js::_processIncomingMessage). Qualquer grupo criado por
 * POST /groups continua com mensagem recebida descartada, sem mudança.
 */
function createCardGroupRouter({ sessions }) {
  const router = express.Router();

  // Resolve nome + telefone de um Bitrix user id, com dedupe: se a mesma
  // pessoa ocupar mais de um papel (ex: é Responsável E clicou no botão),
  // ela entra só uma vez na lista de participantes — mas aparece nos dois
  // `role`s no retorno, pra UI mostrar os papéis reais sem duplicar convite.
  async function resolveParticipant(role, bitrixUserId) {
    if (!bitrixUserId) return { role, bitrixUserId: null, name: null, phone: null, resolved: false };
    const info = await getEmployeeInfo(bitrixUserId).catch((err) => {
      console.error('[cardGroup] falha ao resolver funcionário:', err.message);
      return null;
    });
    const phone = normalizeBrazilPhone(info?.phone);
    return { role, bitrixUserId, name: info?.name || null, phone, resolved: !!phone };
  }

  // GET /participants?session=&dealId=
  // Resolve os 3 participantes internos padrão (Responsável, Verificação,
  // quem está logado) pra exibir no modal de criação — nunca falha com 500
  // por um participante sem celular/campo vazio (best-effort, resolved:false
  // sinaliza pra UI decidir o que fazer).
  router.get('/participants', requireSession((req) => req.query.session), async (req, res) => {
    const { dealId } = req.query;
    if (!dealId) return res.status(400).json({ error: 'dealId é obrigatório' });

    try {
      const deal = await callBitrix('crm.deal.get', { id: dealId });
      if (!deal) {
        return res.status(502).json({ error: 'não foi possível carregar o negócio no Bitrix (webhook indisponível ou negócio inexistente)' });
      }

      // Só o Responsável PRINCIPAL (ASSIGNED_BY_ID) — decisão confirmada
      // com o usuário: 2º Responsável/Supervisor do Responsável ficam de
      // fora, mesmo quando preenchidos no card.
      const assignedById = deal.ASSIGNED_BY_ID || null;
      const verificationUserId = await getVerificationResponsibleUserId(deal).catch((err) => {
        console.error('[cardGroup] falha ao resolver campo de Verificação:', err.message);
        return null;
      });
      const requesterUserId = bitrixUserIdFromOwnerId(req.ownerId);

      const [assigned, verification, requester] = await Promise.all([
        resolveParticipant('assigned', assignedById),
        resolveParticipant('verification', verificationUserId),
        resolveParticipant('requester', requesterUserId),
      ]);

      // Se o CAMPO em si foi localizado em crm.deal.fields (independente de
      // ter valor preenchido NESTE negócio específico) — a UI usa isso pra
      // distinguir "campo vazio neste negócio" de "campo nem existe/não foi
      // possível resolver o nome técnico dele" (ver bitrixDealFields.js).
      const customFieldName = await resolveCustomFieldName().catch(() => null);

      res.json({
        participants: [assigned, verification, requester],
        customFieldFound: customFieldName !== null,
      });
    } catch (err) {
      console.error('[cardGroup] erro ao resolver participantes:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /  { session, dealId, name, phones: [...] }
  // Cria o grupo de verdade via gateway.createGroup (já existente, sem
  // nenhuma mudança em whatsapp.js aqui) e marca em wa_groups como
  // source='card' — é essa marca que liga o bypass do descarte de mensagem
  // recebida (ver whatsapp.js) e o switch Cliente/Grupo no frontend.
  router.post('/', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, dealId, name, phones } = req.body || {};
    if (!dealId) return res.status(400).json({ error: 'dealId é obrigatório' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });

    const uniquePhones = [...new Set((Array.isArray(phones) ? phones : []).map((p) => String(p).replace(/\D/g, '')).filter(Boolean))];
    if (uniquePhones.length < 1) {
      return res.status(400).json({ error: 'selecione ao menos um participante para o grupo' });
    }

    let gateway;
    try {
      gateway = sessions.get(session);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (gateway.getStatus() !== 'online') {
      return res.status(409).json({ error: 'Essa sessão não está com o WhatsApp conectado no momento' });
    }

    try {
      const group = await gateway.createGroup(name.trim(), uniquePhones);
      await store.createGroupRecord(group.id, session, group.name, group.participantCount, { source: 'card', dealId: String(dealId) });
      actionLog.logAction(req.ownerId, 'card_group_created', group.name);
      res.json({ ok: true, group });
    } catch (err) {
      console.error('[cardGroup] erro ao criar grupo:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /?session=&dealId=
  // Grupo de card já criado pra este negócio, se houver — alimenta o
  // switch Cliente/Grupo na tela decidir se mostra a opção "Grupo".
  router.get('/', requireSession((req) => req.query.session), async (req, res) => {
    const { dealId } = req.query;
    if (!dealId) return res.status(400).json({ error: 'dealId é obrigatório' });
    try {
      const group = await store.getCardGroupForDeal(req.sessionIds, String(dealId));
      res.json({ group });
    } catch (err) {
      console.error('[cardGroup] erro ao buscar grupo do negócio:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createCardGroupRouter };
