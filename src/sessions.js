const fs = require('fs');
const path = require('path');
const { WhatsAppGateway } = require('./whatsapp');

/**
 * Gerencia VÁRIAS sessões de WhatsApp — uma por usuário do Bitrix.
 * Cada sessão tem sua própria pasta de credenciais em <baseFolder>/<sessionId>,
 * então cada usuário conecta o próprio número escaneando o QR dele.
 *
 * O sessionId vem do Bitrix (member_id + id do usuário) e é usado como nome
 * de pasta, por isso é sanitizado para evitar path traversal.
 */

function sanitize(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

class SessionManager {
  constructor({ baseFolder, onStatus, onMessage, onReaction, onMessageStatus, onPresence }) {
    this.baseFolder = baseFolder;
    this.onStatus = onStatus; // (sessionId, status) => void
    this.onMessage = onMessage; // (sessionId, phone, message, pushName) => void
    this.onReaction = onReaction; // (sessionId, phone, targetId, emoji, direction) => void
    this.onMessageStatus = onMessageStatus; // (sessionId, phone, messageId, status) => void
    this.onPresence = onPresence; // (sessionId, phone, state) => void
    this.sessions = new Map(); // sessionId -> WhatsAppGateway
  }

  /**
   * Devolve (criando e iniciando se necessário) o gateway daquele usuário.
   * Iniciar gera um QR novo caso ainda não exista sessão pareada na pasta.
   */
  get(sessionId) {
    const id = sanitize(sessionId);
    if (!id) throw new Error('sessão inválida');
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      // Sem isso, uma sessão deslogada pelo celular fica "morta" pra sempre —
      // requestFreshQr() não faz nada se ela não estiver deslogada, então é
      // seguro chamar em todo acesso (cada /qr, /status, /send, etc.).
      existing.requestFreshQr().catch((err) =>
        console.error(`[whatsapp:${id}] falha ao reiniciar sessão deslogada:`, err.message)
      );
      return existing;
    }

    const gateway = new WhatsAppGateway({
      authFolder: path.join(this.baseFolder, id),
    });
    gateway.on('status', (status) => this.onStatus(id, status));
    gateway.on('message', ({ phone, message, pushName }) => this.onMessage(id, phone, message, pushName));
    gateway.on('reaction', ({ phone, targetId, emoji, direction }) => this.onReaction?.(id, phone, targetId, emoji, direction));
    gateway.on('messageStatus', ({ phone, messageId, status }) => this.onMessageStatus?.(id, phone, messageId, status));
    gateway.on('presence', ({ phone, state }) => this.onPresence?.(id, phone, state));
    gateway.start().catch((err) =>
      console.error(`[whatsapp:${id}] falha ao iniciar sessão:`, err.message)
    );

    this.sessions.set(id, gateway);
    return gateway;
  }

  /**
   * Desconecta e apaga uma sessão (usado ao remover uma instância). Some do
   * mapa em memória e limpa a pasta de credenciais em disco.
   */
  async remove(sessionId) {
    const id = sanitize(sessionId);
    const gateway = this.sessions.get(id);
    if (gateway) {
      await gateway.disconnect();
      this.sessions.delete(id);
      return;
    }
    const folder = path.join(this.baseFolder, id);
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  /**
   * No boot do servidor, reinicia todas as sessões que já têm credenciais
   * salvas em disco — assim usuários já pareados voltam a receber mensagens
   * mesmo sem ninguém ter aberto a aba ainda.
   */
  startAllExisting() {
    if (!fs.existsSync(this.baseFolder)) return;
    const entries = fs.readdirSync(this.baseFolder, { withFileTypes: true });
    for (const entry of entries) {
      // cada sessão pareada é uma subpasta com um creds.json dentro
      if (!entry.isDirectory()) continue;
      const credsPath = path.join(this.baseFolder, entry.name, 'creds.json');
      if (fs.existsSync(credsPath)) {
        console.log(`[sessions] retomando sessão salva: ${entry.name}`);
        this.get(entry.name);
      }
    }
  }
}

module.exports = { SessionManager, sanitize };
