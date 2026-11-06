const express = require('express');
const panelAuth = require('../panelAuth');
const panelStore = require('../panelStore');
const panelService = require('../panelService');
const { getEmployees } = require('../teamDirectory');
const { buildPhoneAuditWorkbook } = require('../phoneAudit');

/**
 * API do painel de auditoria (/api/panel/*). Autenticação PRÓPRIA (usuário + senha, cookie de
 * sessão), não a do Bitrix — ver src/panelAuth.js. Tudo que muda algo fica em panel_audit.
 * Só leitura sobre as sessões do WhatsApp: nada aqui inicia, reconecta ou apaga sessão.
 */

const CHANNELS = ['app', 'push', 'whatsapp', 'email'];
const isId = (v) => /^\d{1,12}$/.test(String(v));

function createPanelRouter({ sessions }) {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (panelStore.tablesMissing(err)) return res.status(503).json({ error: 'tabelas do painel ainda não foram criadas (db/painel.sql)', setup: true });
      console.error(`[panel] ${req.method} ${req.path}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
    }
  };

  // ---- sessão ----
  router.post('/login', panelAuth.login);
  router.post('/logout', (req, res) => { panelAuth.clearSessionCookie(req, res); res.json({ ok: true }); });
  router.get('/me', panelAuth.requirePanelAuth, (req, res) => res.json({ user: req.panelUser }));

  router.use(panelAuth.requirePanelAuth);

  router.post('/password', wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof next !== 'string' || next.length < panelAuth.MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `a nova senha precisa ter pelo menos ${panelAuth.MIN_PASSWORD_LENGTH} caracteres` });
    }
    const user = await panelStore.getUserByName(req.panelUser.username);
    if (!user || !(await panelAuth.verifyPassword(String(current || ''), user.passwordHash))) {
      return res.status(401).json({ error: 'senha atual incorreta' });
    }
    await panelStore.setPassword(user.id, await panelAuth.hashPassword(next));
    panelAuth.forgetUser(user.username);
    await panelStore.logAudit(req.panelUser.username, 'senha_alterada');
    res.json({ ok: true });
  }));

  // ---- dados principais ----
  router.get('/data', wrap(async (req, res) => {
    const force = req.query.force === '1';
    const { audit, people, hrConfigured } = await panelService.getPeople(sessions, { force });
    const teams = panelService.buildTeams(people).map((t) => ({
      key: t.key, managerId: t.managerId, managerName: t.managerName, departments: t.departments, counts: t.counts,
      memberIds: t.members.map((m) => m.bitrixUserId || m.ownerId),
    }));
    const active = people.filter((p) => p.activeInBitrix !== false);
    const count = (state) => active.filter((p) => p.state === state).length;
    const s = audit.summary;
    res.json({
      generatedAt: s.generatedAt,
      hrConfigured,
      sessionsInMemory: s.sessionsInMemory,
      summary: {
        employees: active.length,
        connected: count('conectado'), offline: count('offline'), notVerified: count('nao_verificado'),
        neverConnected: count('nunca_conectou'), noInstance: count('sem_instancia'),
        distinctNumbers: s.phones.distinct, repeatedNumbers: s.phones.repeated, orphanNumbers: s.phones.orphanOrDiskOnly,
        instances: s.instances.total, instancesOnline: s.instances.connectedNow, needsAttention: s.instances.needsAttention, banned: s.instances.banned,
        ownersNotActive: s.people.ownersNotActiveInBitrix,
        teams: teams.filter((t) => t.managerId).length,
        noManager: (teams.find((t) => t.key === '_none')?.counts.total) || 0,
      },
      teams,
      people: people.map((p) => ({ ...p, bitrixUserId: p.bitrixUserId || null })),
      repeatedPhones: audit.repeatedPhones,
      orphanPhones: audit.orphanPhones,
    });
  }));

  // ---- exportação ----
  const SITUATION = panelService.SITUATION_LABEL;
  const csvCell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // planilha não executa fórmula vinda de dado
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  router.get('/export', wrap(async (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const team = req.query.team ? String(req.query.team) : null;
    const { audit, people } = await panelService.getPeople(sessions, { force: req.query.force === '1' });
    const teams = panelService.buildTeams(people);
    const chosen = team ? teams.filter((t) => t.key === team) : teams;
    const members = chosen.flatMap((t) => t.members.map((m) => ({ ...m, team: t })));
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    await panelStore.logAudit(req.panelUser.username, 'exportacao', `${format}${team ? ` equipe ${team}` : ''} (${members.length} pessoas)`);

    if (format === 'csv') {
      const header = ['Nome', 'ID Bitrix', 'Departamento', 'Gestor (recebe o alerta)', 'Origem do gestor', 'Situação', 'Números', 'Instâncias'];
      const lines = [header.map(csvCell).join(';')];
      for (const m of members) {
        lines.push([m.name, m.bitrixUserId, m.department, m.team.managerName, m.recipient?.source, SITUATION[m.state], m.phones.join(' / '), m.instances.length].map(csvCell).join(';'));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dapzap-painel-${day}.csv"`);
      return res.send('﻿' + lines.join('\r\n'));
    }

    const wb = await buildPhoneAuditWorkbook(audit);
    const head = (ws, widths) => {
      ws.columns.forEach((c, i) => { c.width = widths[i] || 16; });
      const r = ws.getRow(1);
      r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F4F' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    };
    const wsT = wb.addWorksheet('Equipes');
    wsT.addRow(['Gestor (recebe o alerta)', 'Departamentos', 'Pessoas', 'Conectados', 'Offline (caiu)', 'Não verificado', 'Nunca conectou', 'Sem instância']);
    for (const t of chosen) wsT.addRow([t.managerName, t.departments.join(', '), t.counts.total, t.counts.conectado, t.counts.offline, t.counts.nao_verificado, t.counts.nunca_conectou, t.counts.sem_instancia]);
    head(wsT, [32, 40, 10, 12, 14, 14, 14, 14]);
    const wsM = wb.addWorksheet('Membros por equipe');
    wsM.addRow(['Gestor (recebe o alerta)', 'Origem', 'Nome', 'ID Bitrix', 'Departamento', 'Situação', 'Números']);
    for (const m of members) {
      const row = wsM.addRow([m.team.managerName, m.recipient?.source || '', m.name, m.bitrixUserId, m.department, SITUATION[m.state], m.phones.join('; ')]);
      row.getCell(7).numFmt = '@';
    }
    head(wsM, [32, 30, 32, 11, 24, 18, 34]);
    const alerts = await panelStore.listAlerts({ limit: 2000 }).catch(() => []);
    const wsA = wb.addWorksheet('Alertas');
    wsA.addRow(['Quando', 'Tipo', 'Pessoa', 'Número', 'Gestor avisado', 'Origem', 'Situação do envio', 'Detalhe']);
    for (const a of alerts) {
      wsA.addRow([new Date(a.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), a.kind, a.personName || '', a.phone || '', a.recipientName || '', a.routeSource || '', a.status, a.detail || ''])
        .getCell(4).numFmt = '@';
    }
    head(wsA, [18, 18, 30, 16, 28, 30, 16, 40]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="dapzap-painel-${day}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }));

  // ---- configurações do monitor ----
  router.get('/settings', wrap(async (req, res) => res.json(await panelStore.getSettings({ fresh: true }))));

  router.put('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const user = req.panelUser.username;
    const changes = [];
    if (typeof b.monitor_enabled === 'boolean') {
      const cur = (await panelStore.getSettings({ fresh: true })).monitor_enabled === 'true';
      if (cur !== b.monitor_enabled) {
        await panelStore.setSetting('monitor_enabled', b.monitor_enabled, user);
        if (b.monitor_enabled) await panelStore.setSetting('monitor_enabled_at', new Date().toISOString(), user); // só eventos daqui pra frente avisam
        changes.push(`monitor ${b.monitor_enabled ? 'LIGADO' : 'desligado'}`);
      }
    }
    if (typeof b.digest_enabled === 'boolean') { await panelStore.setSetting('digest_enabled', b.digest_enabled, user); changes.push(`resumo diário ${b.digest_enabled ? 'ligado' : 'desligado'}`); }
    if (b.grace_minutes != null) {
      const n = Number(b.grace_minutes);
      if (!Number.isInteger(n) || n < 5 || n > 720) return res.status(400).json({ error: 'espera deve ficar entre 5 e 720 minutos' });
      await panelStore.setSetting('grace_minutes', n, user); changes.push(`espera ${n} min`);
    }
    if (b.digest_hour != null) {
      const n = Number(b.digest_hour);
      if (!Number.isInteger(n) || n < 0 || n > 23) return res.status(400).json({ error: 'hora do resumo deve ficar entre 0 e 23' });
      await panelStore.setSetting('digest_hour', n, user); changes.push(`resumo às ${n}h`);
    }
    if (changes.length) await panelStore.logAudit(user, 'configuracao', changes.join('; '));
    res.json(await panelStore.getSettings({ fresh: true }));
  }));

  // ---- regras de destinatário ----
  router.get('/routes', wrap(async (req, res) => {
    const [routes, dir] = await Promise.all([panelStore.listRoutes({ fresh: true }), getEmployees()]);
    const departments = [...new Set((dir.employees || []).map((e) => e.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    res.json({ routes, departments });
  }));

  router.post('/routes', wrap(async (req, res) => {
    const { scopeType, scopeValue, recipientBitrixId, note } = req.body || {};
    if (!['person', 'department'].includes(scopeType)) return res.status(400).json({ error: 'tipo de regra inválido' });
    if (!isId(recipientBitrixId)) return res.status(400).json({ error: 'gestor inválido' });
    const dir = await getEmployees();
    if (!dir.employees) return res.status(503).json({ error: 'cadastro do Bitrix indisponível no momento' });
    const recipient = dir.byId.get(String(recipientBitrixId));
    if (!recipient) return res.status(400).json({ error: 'gestor não encontrado entre os colaboradores ativos do Bitrix' });
    let label;
    if (scopeType === 'person') {
      const p = dir.byId.get(String(scopeValue));
      if (!p) return res.status(400).json({ error: 'pessoa não encontrada entre os colaboradores ativos do Bitrix' });
      label = p.name;
    } else {
      if (!dir.employees.some((e) => e.department === scopeValue)) return res.status(400).json({ error: 'departamento não encontrado' });
      label = scopeValue;
    }
    await panelStore.upsertRoute({
      scopeType, scopeValue: String(scopeValue), scopeLabel: label, recipientBitrixId: String(recipientBitrixId),
      recipientName: recipient.name, note: String(note || '').slice(0, 200), username: req.panelUser.username,
    });
    await panelStore.logAudit(req.panelUser.username, 'regra_salva', `${scopeType} ${label} -> ${recipient.name}`);
    res.json({ ok: true });
  }));

  router.delete('/routes/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const ok = await panelStore.deleteRoute(req.params.id);
    if (ok) await panelStore.logAudit(req.panelUser.username, 'regra_removida', `id ${req.params.id}`);
    res.json({ ok });
  }));

  router.get('/employees', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    if (q.length < 2) return res.json({ employees: [] });
    const dir = await getEmployees();
    const out = (dir.employees || [])
      .filter((e) => String(e.name || '').toLowerCase().includes(q))
      .slice(0, 20)
      .map((e) => ({ id: e.id, name: e.name, department: e.department }));
    res.json({ employees: out });
  }));

  // ---- histórico ----
  router.get('/alerts', wrap(async (req, res) => {
    const { kind, status, recipient } = req.query;
    res.json({ alerts: await panelStore.listAlerts({ limit: req.query.limit, kind: kind || undefined, status: status || undefined, recipient: recipient || undefined }) });
  }));

  router.get('/audit', wrap(async (req, res) => res.json({ entries: await panelStore.listAudit(req.query.limit) })));

  // ---- disparos ----
  const sendLog = []; // limite simples: 10 disparos a cada 10 minutos por usuário
  function sendAllowed(username) {
    const now = Date.now();
    while (sendLog.length && now - sendLog[0].at > 10 * 60 * 1000) sendLog.shift();
    if (sendLog.filter((s) => s.username === username).length >= 10) return false;
    sendLog.push({ username, at: now });
    return true;
  }

  function parseChannels(raw) {
    const list = Array.isArray(raw) ? raw.filter((c) => CHANNELS.includes(c)) : [];
    return list.length ? list : null;
  }

  router.post('/notify', wrap(async (req, res) => {
    const { bitrixIds, title, body, channels } = req.body || {};
    if (!Array.isArray(bitrixIds) || !bitrixIds.length || bitrixIds.length > 500 || !bitrixIds.every(isId)) {
      return res.status(400).json({ error: 'escolha de 1 a 500 pessoas' });
    }
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t || t.length > 120) return res.status(400).json({ error: 'título obrigatório (até 120 caracteres)' });
    if (b.length > 2000) return res.status(400).json({ error: 'mensagem muito longa (máximo 2000 caracteres)' });
    const ch = parseChannels(channels);
    if (!ch) return res.status(400).json({ error: 'escolha pelo menos um canal' });
    const dir = await getEmployees();
    const valid = bitrixIds.filter((id) => dir.byId.has(String(id)));
    if (!valid.length) return res.status(400).json({ error: 'nenhuma das pessoas está ativa no Bitrix' });
    if (!sendAllowed(req.panelUser.username)) return res.status(429).json({ error: 'muitos disparos seguidos — aguarde alguns minutos' });
    const results = await panelService.sendManual(sessions, { bitrixIds: valid, title: t, body: b, channels: ch, username: req.panelUser.username });
    await panelStore.logAudit(req.panelUser.username, 'disparo_manual', `"${t}" para ${valid.length} pessoa(s) por ${ch.join('+')}`);
    res.json({ sent: results.filter((r) => r.status === 'enviado').length, failed: results.filter((r) => r.status === 'falhou').length, ignored: bitrixIds.length - valid.length });
  }));

  // Resumo para os gestores (previa=true só mostra, sem enviar).
  router.post('/digest', wrap(async (req, res) => {
    const { dryRun, managerIds, channels } = req.body || {};
    if (managerIds != null && (!Array.isArray(managerIds) || !managerIds.every(isId))) return res.status(400).json({ error: 'gestores inválidos' });
    const preview = dryRun !== false;
    if (!preview && !sendAllowed(req.panelUser.username)) return res.status(429).json({ error: 'muitos disparos seguidos — aguarde alguns minutos' });
    // `day` com a data de hoje: o mesmo resumo não sai duas vezes no dia nem se alguém clicar de novo.
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const results = await panelService.sendDigests(sessions, { onlyManagerIds: managerIds || null, dryRun: preview, channels: parseChannels(channels), day });
    if (!preview) await panelStore.logAudit(req.panelUser.username, 'resumo_manual', `${results.filter((r) => r.status === 'enviado').length} gestor(es)`);
    res.json({ results });
  }));

  return router;
}

module.exports = { createPanelRouter };
