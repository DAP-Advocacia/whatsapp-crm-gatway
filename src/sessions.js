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
    this.onMessage = onMessage; // (sessionId, phone, message, pushName, isHistory) => void
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
    gateway.on('message', ({ phone, message, pushName, isHistory }) => this.onMessage(id, phone, message, pushName, isHistory));
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
   *
   * Escalonado (um a cada STAGGER_MS, não tudo de uma vez): abrir dezenas de
   * conexões WebSocket pro WhatsApp no mesmo instante parece pro WhatsApp um
   * padrão de login em massa a partir do mesmo processo/IP, e a defesa
   * anti-abuso deles reage derrubando (deslogando) sessões — foi o que
   * causou o incidente de 31/07/2026 (instância 183168 e outras deslogadas
   * após um deploy). Um delay entre cada reconexão evita esse pico.
   */
  async startAllExisting() {
    if (!fs.existsSync(this.baseFolder)) return;
    const STAGGER_MS = Number(process.env.SESSION_STAGGER_MS || 15000);
    const entries = fs.readdirSync(this.baseFolder, { withFileTypes: true });
    const pending = entries.filter((entry) => {
      if (!entry.isDirectory()) return false;
      const credsPath = path.join(this.baseFolder, entry.name, 'creds.json');
      return fs.existsSync(credsPath);
    });
    console.log(`[sessions] retomando ${pending.length} sessão(ões) salva(s), escalonado a cada ${STAGGER_MS}ms`);
    for (const entry of pending) {
      console.log(`[sessions] retomando sessão salva: ${entry.name}`);
      this.get(entry.name);
      if (entry !== pending[pending.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
      }
    }
  }
}

module.exports = { SessionManager, sanitize };
