/**
 * Especificação OpenAPI 3.0 da API REST — servida em GET /api-docs (Swagger
 * UI, ver src/server.js). Cobre as mesmas rotas já listadas em README.md §16,
 * só que em formato interativo/machine-readable pra equipe consumir de fora
 * do navegador (scripts, Postman, Power Query) — ver botão "Gerar novo
 * token" em /settings.html pra conseguir um Bearer token de uso longo.
 *
 * Esta página em si é pública (só documentação, nenhum dado) — as chamadas
 * de verdade continuam exigindo o token, igual sempre (ver src/auth.js).
 */

const bearerAuth = { bearerAuth: [] };

const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
};

function jsonResponse(description, schema) {
  return { description, content: { 'application/json': { schema: schema || { type: 'object' } } } };
}

const sessionParam = { name: 'session', in: 'query', required: true, schema: { type: 'string' }, description: 'ID da instância (sessão de WhatsApp)' };
const ownerParam = { name: 'owner', in: 'query', schema: { type: 'string' }, description: 'ID do dono (member_id_userId) — quando omitido, usa o dono do próprio token' };
const phoneParam = { name: 'phone', in: 'query', required: true, schema: { type: 'string' }, description: 'Telefone em E.164 sem "+" (ex: 5521999999999)' };

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WhatsApp ↔ Bitrix24 Gateway — API interna',
    version: '1.0.0',
    description:
      'API REST consumida pelas telas do próprio app (dashboard, chat, campanhas, contatos, sites) — documentada aqui ' +
      'pra também poder ser usada pela equipe fora do navegador. Todas as rotas abaixo (exceto onde marcado) exigem ' +
      'um Bearer token: gere o seu em /settings.html, seção "Token de API" (validade de 90 dias). ' +
      'Detalhe completo de cada campo/comportamento em README.md §16 do repositório.',
  },
  servers: [{ url: '/', description: 'Este servidor' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token gerado em /settings.html → "Token de API"' },
    },
  },
  security: [bearerAuth],
  tags: [
    { name: 'WhatsApp — métricas e insights' },
    { name: 'WhatsApp — instâncias e conexão' },
    { name: 'WhatsApp — chat e conversas' },
    { name: 'WhatsApp — grupos' },
    { name: 'WhatsApp — notificações' },
    { name: 'WhatsApp — envio' },
    { name: 'WhatsApp — campanhas e agendamentos' },
    { name: 'Contatos e listas' },
    { name: 'Modelos de mensagem' },
    { name: 'Configurações' },
    { name: 'Admin (restrito)' },
  ],
  paths: {
    '/api/whatsapp/metrics': {
      get: {
        tags: ['WhatsApp — métricas e insights'],
        summary: 'Métricas agregadas das instâncias do dono autenticado',
        parameters: [{ name: 'origin', in: 'query', schema: { type: 'string', enum: ['interna', 'externa'] }, description: 'Filtra por conversas internas (entre instâncias conhecidas) ou externas' }],
        responses: { 200: jsonResponse('Métricas agregadas (totais, por tipo, por sessão, tendência MoM/YoY, etapas do Bitrix)') },
      },
    },
    '/api/whatsapp/insights': {
      get: {
        tags: ['WhatsApp — métricas e insights'],
        summary: 'Cards de "Insights de IA" do Dashboard',
        parameters: [{ name: 'refresh', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Força recalcular, ignorando o cache de 30min' }],
        responses: { 200: jsonResponse('Lista de insights {title, text, tone} + generatedAt + cached') },
      },
    },
    '/api/whatsapp/sessions': {
      get: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Status de uma instância (ou de todas, sem o parâmetro)',
        parameters: [{ ...sessionParam, required: false }],
        responses: { 200: jsonResponse('Status por sessão') },
      },
    },
    '/api/whatsapp/instances': {
      get: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Lista as instâncias do dono (cria a "Principal" se não existir nenhuma)',
        parameters: [ownerParam],
        responses: { 200: jsonResponse('{ instances: [{id, ownerId, label, status, phone, contactCount, groupCount, createdAt}] }') },
      },
      post: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Cria uma instância nova e inicia o pareamento (QR)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['owner', 'label'], properties: { owner: { type: 'string' }, label: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Instância criada'), 400: jsonResponse('Erro de validação', errorResponse) },
      },
    },
    '/api/whatsapp/instances/{id}': {
      put: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Renomeia uma instância',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { owner: { type: 'string' }, label: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Instância atualizada') },
      },
      delete: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Desconecta e remove a instância',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, ownerParam],
        responses: { 200: jsonResponse('Removida') },
      },
    },
    '/api/whatsapp/instances/{id}/delegates': {
      get: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Lista quem tem acesso delegado a esta instância (só o dono vê)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, ownerParam],
        responses: { 200: jsonResponse('{ delegates: [{delegateOwnerId, delegateName, createdAt}] }') },
      },
      post: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Concede acesso à instância pra outro usuário do Bitrix (só o dono pode)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['owner', 'delegateOwnerId'], properties: { owner: { type: 'string' }, delegateOwnerId: { type: 'string' }, delegateName: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('ok'), 400: jsonResponse('Erro de validação', errorResponse) },
      },
    },
    '/api/whatsapp/instances/{id}/delegates/{delegateOwnerId}': {
      delete: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Revoga o acesso delegado (só o dono pode)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'delegateOwnerId', in: 'path', required: true, schema: { type: 'string' } }, ownerParam],
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/qr': {
      get: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Cria/inicia a instância e devolve o QR Code pra parear',
        parameters: [sessionParam],
        responses: { 200: jsonResponse('{ qr, status }') },
      },
    },
    '/api/whatsapp/status': {
      get: {
        tags: ['WhatsApp — instâncias e conexão'],
        summary: 'Status da instância',
        parameters: [sessionParam],
        responses: { 200: jsonResponse("{ status: 'connecting' | 'online' | 'offline' }") },
      },
    },
    '/api/whatsapp/avatar': {
      get: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Foto de perfil do contato/grupo (cacheada)',
        parameters: [sessionParam, phoneParam],
        responses: { 200: jsonResponse('{ url }') },
      },
    },
    '/api/whatsapp/history': {
      get: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Histórico de mensagens de uma conversa',
        parameters: [sessionParam, { name: 'dealId', in: 'query', schema: { type: 'string' } }, phoneParam],
        responses: { 200: jsonResponse('Mensagens + connectionStatus + aiSummary') },
      },
    },
    '/api/whatsapp/conversations': {
      get: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Lista as conversas (tela Chat)',
        parameters: [sessionParam, { name: 'search', in: 'query', schema: { type: 'string' } }, { name: 'archived', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
        responses: { 200: jsonResponse('Lista de conversas com nome, prévia, tags') },
      },
    },
    '/api/whatsapp/conversations/archive': {
      post: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Arquiva/desarquiva uma conversa',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { session: { type: 'string' }, phone: { type: 'string' }, archived: { type: 'boolean' } } } } } },
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/conversations/assign': {
      post: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Atribui (ou desatribui, com assignedTo null) o atendimento de uma conversa',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'phone'], properties: { session: { type: 'string' }, phone: { type: 'string' }, assignedTo: { type: 'string', nullable: true }, assignedToName: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('ok'), 400: jsonResponse('assignedTo inválido', errorResponse) },
      },
    },
    '/api/whatsapp/conversations/mark-read': {
      post: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Marca como lidas as notificações desta conversa',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'phone'], properties: { session: { type: 'string' }, phone: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/conversations/notifications': {
      post: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Silencia/dessilencia notificações de uma conversa',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { session: { type: 'string' }, phone: { type: 'string' }, enabled: { type: 'boolean' } } } } } },
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/conversations/summary': {
      post: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Gera (OpenAI) e persiste o resumo estruturado da conversa',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'phone'], properties: { session: { type: 'string' }, phone: { type: 'string' }, contactName: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('{ title, subtitle, summary, updatedAt }') },
      },
    },
    '/api/whatsapp/conversations/move-instance': {
      post: {
        tags: ['WhatsApp — chat e conversas'],
        summary: 'Move uma conversa em andamento pra outra instância do mesmo dono',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { session: { type: 'string' }, phone: { type: 'string' }, targetSession: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('ok'), 409: jsonResponse('Conversa já existe na instância de destino', errorResponse) },
      },
    },
    '/api/whatsapp/groups': {
      get: {
        tags: ['WhatsApp — grupos'],
        summary: 'Lista os grupos já criados pela(s) instância(s)',
        parameters: [{ ...sessionParam, description: 'Uma instância ou várias separadas por vírgula' }],
        responses: { 200: jsonResponse('Lista de grupos') },
      },
      post: {
        tags: ['WhatsApp — grupos'],
        summary: 'Cria um grupo de verdade no WhatsApp',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'name', 'phones'], properties: { session: { type: 'string' }, name: { type: 'string' }, phones: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { 200: jsonResponse('Grupo criado') },
      },
    },
    '/api/whatsapp/contacts/groups': {
      get: {
        tags: ['WhatsApp — grupos'],
        summary: 'Grupos da instância dos quais um telefone é participante ("grupos em comum")',
        parameters: [sessionParam, phoneParam],
        responses: { 200: jsonResponse('{ groups: [{id, name}] }') },
      },
    },
    '/api/whatsapp/notifications': {
      get: {
        tags: ['WhatsApp — notificações'],
        summary: 'Histórico de notificações do dono (mais recentes primeiro, limit 500)',
        parameters: [ownerParam],
        responses: { 200: jsonResponse('Lista de notificações') },
      },
    },
    '/api/whatsapp/notifications/unread-count': {
      get: {
        tags: ['WhatsApp — notificações'],
        summary: 'Contagem de não lidas (badge do sino)',
        parameters: [ownerParam],
        responses: { 200: jsonResponse('{ count }') },
      },
    },
    '/api/whatsapp/notifications/read-all': {
      post: {
        tags: ['WhatsApp — notificações'],
        summary: 'Marca todas as notificações do dono como lidas',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { owner: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/notifications/{id}/read': {
      post: {
        tags: ['WhatsApp — notificações'],
        summary: 'Marca uma notificação como lida/não lida',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { read: { type: 'boolean' } } } } } },
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/send': {
      post: {
        tags: ['WhatsApp — envio'],
        summary: 'Envia uma mensagem de texto',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'phone', 'text'], properties: { session: { type: 'string' }, dealId: { type: 'string' }, phone: { type: 'string' }, text: { type: 'string' }, replyToId: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Mensagem enviada') },
      },
    },
    '/api/whatsapp/send-media': {
      post: {
        tags: ['WhatsApp — envio'],
        summary: 'Envia imagem/áudio/vídeo (base64)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'phone', 'type', 'mimetype', 'dataBase64'], properties: { session: { type: 'string' }, dealId: { type: 'string' }, phone: { type: 'string' }, type: { type: 'string', enum: ['image', 'audio', 'video'] }, mimetype: { type: 'string' }, dataBase64: { type: 'string' }, caption: { type: 'string' }, replyToId: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Mídia enviada') },
      },
    },
    '/api/whatsapp/react': {
      post: {
        tags: ['WhatsApp — envio'],
        summary: 'Reage a uma mensagem (emoji vazio remove a reação)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { session: { type: 'string' }, phone: { type: 'string' }, messageId: { type: 'string' }, emoji: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('ok') },
      },
    },
    '/api/whatsapp/campaign/classify-recipients': {
      post: {
        tags: ['WhatsApp — campanhas e agendamentos'],
        summary: 'Classifica telefones por risco de erro 463 (já responderam de verdade alguma vez?)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'phones'], properties: { session: { type: 'string' }, phones: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { 200: jsonResponse('{ results: [{phone, hasReplied}] } — telefone sem conversa não aparece') },
      },
    },
    '/api/whatsapp/campaign': {
      post: {
        tags: ['WhatsApp — campanhas e agendamentos'],
        summary: 'Dispara uma campanha imediatamente',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'recipients', 'text'], properties: { session: { type: 'string' }, name: { type: 'string' }, recipients: { type: 'array', items: { type: 'object', properties: { phone: { type: 'string' }, name: { type: 'string' } } } }, text: { type: 'string' }, media: { type: 'object' }, minDelayMs: { type: 'number', description: 'Override do intervalo mínimo entre envios (ms) — 1000 a 120000, padrão 4000' }, maxDelayMs: { type: 'number', description: 'Override do intervalo máximo entre envios (ms) — padrão 9000' } } } } } },
        responses: { 200: jsonResponse('Campanha criada') },
      },
    },
    '/api/whatsapp/campaign/{id}': {
      get: {
        tags: ['WhatsApp — campanhas e agendamentos'],
        summary: 'Progresso "ao vivo" de uma campanha',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Progresso da campanha') },
      },
    },
    '/api/whatsapp/campaigns/metrics': {
      get: {
        tags: ['WhatsApp — campanhas e agendamentos'],
        summary: 'Métricas agregadas de campanhas',
        parameters: [{ ...sessionParam, description: 'Uma instância ou várias separadas por vírgula' }],
        responses: { 200: jsonResponse('Métricas de campanhas') },
      },
    },
    '/api/whatsapp/scheduled-campaigns': {
      get: {
        tags: ['WhatsApp — campanhas e agendamentos'],
        summary: 'Lista os agendamentos (Kanban/Calendário)',
        parameters: [{ ...sessionParam, description: 'Uma instância ou várias separadas por vírgula' }],
        responses: { 200: jsonResponse('Lista de agendamentos') },
      },
    },
    '/api/contacts': {
      get: {
        tags: ['Contatos e listas'],
        summary: 'Lista os contatos do dono autenticado (todas as instâncias)',
        responses: { 200: jsonResponse('Lista de contatos') },
      },
      post: {
        tags: ['Contatos e listas'],
        summary: 'Cria/atualiza um contato (upsert por telefone)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['phone'], properties: { name: { type: 'string' }, phone: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Contato salvo') },
      },
    },
    '/api/contact-lists': {
      get: {
        tags: ['Contatos e listas'],
        summary: 'Lista as listas do dono (com contagem de contatos)',
        responses: { 200: jsonResponse('Lista de listas') },
      },
      post: {
        tags: ['Contatos e listas'],
        summary: 'Cria uma lista',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, contactIds: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { 200: jsonResponse('Lista criada') },
      },
    },
    '/api/templates': {
      get: {
        tags: ['Modelos de mensagem'],
        summary: 'Lista os modelos de mensagem de uma instância',
        parameters: [sessionParam],
        responses: { 200: jsonResponse('Lista de modelos') },
      },
      post: {
        tags: ['Modelos de mensagem'],
        summary: 'Cria um modelo de mensagem',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['session', 'name', 'body'], properties: { session: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Modelo criado') },
      },
    },
    '/api/settings/api-token': {
      post: {
        tags: ['Configurações'],
        summary: 'Gera um novo token de API (validade longa, ver /settings.html)',
        responses: { 200: jsonResponse('{ token, expiresAt }') },
      },
    },
    '/api/whatsapp/presence/heartbeat': {
      post: {
        tags: ['Admin (restrito)'],
        summary: 'Sinal de "app aberto agora" — qualquer usuário autenticado pode chamar (alimenta o painel admin)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { page: { type: 'string', description: 'window.location.pathname de onde o heartbeat foi disparado' }, ownerName: { type: 'string', description: 'Nome já resolvido no frontend (BX24 user.current) — texto solto, não identidade' } } } } } },
        responses: { 200: jsonResponse('{ ok: true }') },
      },
    },
    '/api/whatsapp/admin/whoami': {
      get: {
        tags: ['Admin (restrito)'],
        summary: 'Confirma se o usuário autenticado é super admin (sem expor a lista de admins)',
        responses: { 200: jsonResponse('{ isSuperAdmin: boolean }') },
      },
    },
    '/api/whatsapp/admin/presence': {
      get: {
        tags: ['Admin (restrito)'],
        summary: 'Lista de quem já mandou heartbeat — restrito a super admin (403 pra qualquer outro ownerId)',
        responses: { 200: jsonResponse('{ presence: [{ownerId, ownerName, lastPage, lastSeenAt}] }'), 403: jsonResponse('Acesso restrito', errorResponse) },
      },
    },
    '/api/whatsapp/admin/employees': {
      get: {
        tags: ['Admin (restrito)'],
        summary: 'Cadastro de funcionários do Bitrix (user.get via BITRIX_HR_WEBHOOK_URL) — restrito a super admin',
        responses: { 200: jsonResponse('{ employees: [{id, name, workPosition, email, photo, departmentIds}], hrConfigured: boolean }'), 403: jsonResponse('Acesso restrito', errorResponse) },
      },
    },
  },
};
