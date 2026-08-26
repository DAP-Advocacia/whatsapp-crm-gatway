const express = require('express');
const leadForms = require('../leadForms');
const contacts = require('../contacts');
const store = require('../store');
const { getOwnNumbersBySession } = require('../ownNumbers');

/**
 * Rotas PÚBLICAS (sem login/Bitrix) que alimentam a página /l/<slug>
 * (public/lead-form.html) — quem preenche o formulário nunca autenticou
 * com nada, o `slug` em si é o único "segredo" de acesso, como qualquer
 * link público de formulário. Ver src/routes/leadForms.js para o CRUD
 * autenticado (usado em public/sites.html).
 */
function createLeadsRouter({ sessions, broadcast }) {
  const router = express.Router();

  router.get('/:slug/config', async (req, res) => {
    try {
      const form = await leadForms.getBySlug(req.params.slug);
      if (!form) return res.status(404).json({ error: 'formulário não encontrado' });

      // Visualização da LP — este config é buscado 1x por carregamento da
      // página pública, então é o ponto natural de contagem. Best-effort:
      // falha aqui nunca derruba o carregamento da página.
      leadForms.recordView(form.id).catch((err) => console.error('[leads:view] erro:', err.message));

      // Telefone do WhatsApp conectado à instância deste formulário — só
      // pra mostrar como contato no rodapé da página pública (ex: "ligar"/
      // "WhatsApp"), não usado pra nada além de exibição.
      const contactPhone = getOwnNumbersBySession()[form.sessionId] || null;

      res.json({
        title: form.title,
        subtitle: form.subtitle,
        active: form.active,
        accentColor: form.accentColor,
        logoUrl: form.logoUrl,
        heroImageUrl: form.heroImageUrl,
        heroMediaType: form.heroMediaType,
        contactPhone,
        testimonials: form.testimonials || [],
        stats: form.stats || [],
        differentials: form.differentials || [],
        faq: form.faq || [],
        storyTitle: form.storyTitle,
        storyText: form.storyText,
      });
    } catch (err) {
      console.error('[leads:config] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/:slug', async (req, res) => {
    const { name, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'telefone é obrigatório' });
    let cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10) return res.status(400).json({ error: 'telefone inválido' });
    // O campo pede "Telefone (com DDD)", sem o código do país — visitante
    // digita 10 (DDD + fixo) ou 11 (DDD + celular) dígitos, sem o "55". Sem
    // esse prefixo, o JID montado em `_phoneToJid` (src/whatsapp.js) não
    // corresponde a nenhuma conta real do WhatsApp: a mensagem aparenta ter
    // sido "enviada" (o servidor confirma recebimento do protocolo), mas
    // nunca chega a lugar nenhum. Detecta pelo tamanho (não por já começar
    // com "55" — DDD 55, RS, é um DDD real, então isso daria falso positivo).
    if (cleanPhone.length <= 11) cleanPhone = `55${cleanPhone}`;
    const cleanName = (name || '').trim() || null;

    try {
      const form = await leadForms.getBySlug(req.params.slug);
      if (!form || !form.active) return res.status(404).json({ error: 'formulário não encontrado' });

      const contact = await contacts.upsertContact(form.ownerId, { name: cleanName, phone: cleanPhone });

      // Marca a conversa que essa mensagem de boas-vindas vai criar com uma
      // tag do nome da própria LP — SDR consegue ver de relance no Chat de
      // qual LP cada lead veio. `fixed: true` — é uma tag do SISTEMA, não
      // algo que o atendente criou à mão, então não aparece removível no
      // Chat (mesmo tratamento das tags "Interno"/"Externo"). `addTagToConversation`
      // cria a conversa sozinha se ainda não existir (getOrCreateConversation
      // interno), então funciona mesmo antes do envio da mensagem de boas-
      // vindas abaixo. Best-effort: nunca bloqueia/derruba a submissão do lead.
      try {
        const tag = await store.createTag(form.sessionId, form.name, form.accentColor || null, true);
        await store.addTagToConversation(form.sessionId, cleanPhone, tag.id);
      } catch (err) {
        console.error('[leads:tag] falha ao aplicar tag da LP:', err.message);
      }

      let whatsappSent = false;
      let welcomeText = null;
      try {
        const gateway = sessions.get(form.sessionId);
        welcomeText = form.welcomeMessage.replace(/\{\{\s*nome\s*\}\}/gi, cleanName || '');
        const message = await gateway.sendMessage(cleanPhone, welcomeText);
        await store.addMessage(form.sessionId, cleanPhone, message, null, null);
        broadcast(form.sessionId, cleanPhone, { type: 'message', message });
        whatsappSent = true;
      } catch (err) {
        // Best-effort: o lead já foi salvo como contato mesmo se a instância
        // escolhida estiver offline no momento — não falha a submissão do
        // formulário por isso, só fica registrado como não enviado.
        console.error('[leads:submit] falha ao enviar mensagem de boas-vindas:', err.message);
      }

      await leadForms.recordSubmission(form.id, { name: cleanName, phone: cleanPhone, contactId: contact.id, whatsappSent });

      // NÃO cria negócio/contato no Bitrix aqui mais (Parte EM) — isso
      // migrou pro momento em que o LEAD RESPONDE à boas-vindas, via
      // src/agentDispatch.js::handleNewLeadMessage (chamado de dentro
      // de onMessage em src/server.js), unificando com o mesmo gatilho
      // já usado pelo fluxo de Campanha. Roda SEMPRE que o lead
      // responde, com ou sem o Agente de IA ativo na instância — só a
      // RESPOSTA AUTOMÁTICA da IA (não a criação do card) depende de
      // agentConfig.active. Motivo da mudança: antes, um lead que
      // preenchia o formulário mas nunca respondia à boas-vindas já
      // virava negócio no Bitrix mesmo sem nenhuma interação real —
      // agora só vira negócio quando existe conversa de fato.
      res.json({ ok: true });
    } catch (err) {
      console.error('[leads:submit] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLeadsRouter };
