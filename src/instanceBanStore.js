const instanceHealthStore = require('./instanceHealthStore');

/**
 * Regra de "instância banida" num só lugar — usada tanto por
 * GET /instances (categoria visual "Banida" na aba Instâncias) quanto
 * pelo poller de aviso (src/instanceBanPoller.js), garantindo que os
 * dois nunca divirjam sobre o que conta como banida.
 *
 * Critério confirmado com o usuário: `forbidden` (ver PERMANENT_CODES,
 * src/whatsapp.js) aberto há mais de 24h — não todo `forbidden` na
 * hora, porque o próprio WhatsApp Business já avisa "resultado da
 * análise em até 24h" (print real do app, ver HANDOFF); marcar antes
 * disso arriscaria rotular como banida uma restrição que ainda ia se
 * resolver sozinha dentro da janela normal de revisão.
 *
 * Sem coluna nova em `instances` — calculado na hora a partir de
 * `instance_connection_events` (decisão confirmada: se a instância
 * reconectar de verdade, o evento fecha sozinho via
 * closeOpenConnectionEvent, já existente, e ela some desta lista sem
 * precisar de nenhum passo de "destravar" manual).
 */

const BAN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// Todas as janelas de 'forbidden' abertas que já cruzaram o limiar —
// cada linha tem { id, instanceId, reason, startedAt }.
async function listBannedNow() {
  const events = await instanceHealthStore.listOpenAttentionEvents(['forbidden']);
  const cutoff = Date.now() - BAN_THRESHOLD_MS;
  return events.filter((e) => new Date(e.startedAt).getTime() < cutoff);
}

module.exports = { listBannedNow, BAN_THRESHOLD_MS };
