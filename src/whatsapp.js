const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  isJidBroadcast,
  isJidNewsletter,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { EventEmitter } = require('events');
const { saveMedia } = require('./media');
const { convertToOggOpus } = require('./audioConvert');

/**
 * Encapsula UMA sessão de WhatsApp pessoal (um número).
 * Emite eventos que o resto da aplicação escuta:
 *   'qr'      -> novo QR Code disponível (data URL base64) para exibir na tela de login
 *   'status'  -> 'connecting' | 'online' | 'offline'
 *   'message' -> nova mensagem (recebida), já normalizada
 *
 * AVISO: isto usa o protocolo não-oficial do WhatsApp Web (engenharia reversa via Baileys).
 * Não é a API oficial da Meta. Veja o aviso de risco de banimento já dado na conversa.
 */
class WhatsAppGateway extends EventEmitter {
  constructor({ authFolder }) {
    super();
    this.authFolder = authFolder;
    this.sock = null;
    this.status = 'offline';
    this.lastQrDataUrl = null;
    // true quando o WhatsApp encerrou a sessão pelo celular (loggedOut) — nesse
    // estado a sessão fica "morta" pra sempre até alguém chamar requestFreshQr().
    this.loggedOut = false;
    // Contatos "vistos" via eventos do Baileys (contacts.upsert/update) —
    // Baileys não expõe uma chamada de "contar contatos" nem um snapshot
    // completo da agenda (só incrementos), então isto é um acumulado em
    // memória desde que o processo subiu, não a agenda telefônica real do
    // celular (que pode ter muito mais contatos nunca vistos pelo WhatsApp
    // Web). Zera a cada reinício do processo/reconexão do zero.
    this.contactIds = new Set();
  }

  getContactCount() {
    return this.contactIds.size;
  }

  /**
   * Grupos reais que este número participa (não é a tabela `wa_groups` local,
   * que só guarda grupos CRIADOS por este app) — ver GET /instances em
   * src/routes/whatsapp.js, card de instância. Só funciona com a sessão
   * online; é uma chamada de rede ao WhatsApp (não instantânea).
   */
  async getGroupCount() {
    if (this.status !== 'online' || !this.sock) return null;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      return Object.keys(groups || {}).length;
    } catch {
      return null;
    }
  }

  getStatus() {
    return this.status;
  }

  getLastQr() {
    return this.lastQrDataUrl;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'warn' }),
      // QR só é necessário até o primeiro pareamento; depois disso a sessão fica
      // salva em `authFolder` e o login persiste entre reinícios do processo.
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQrDataUrl = await QRCode.toDataURL(qr);
        this.status = 'connecting';
        this.loggedOut = false; // já estamos num pareamento novo, não é mais uma sessão "morta"
        this.emit('qr', this.lastQrDataUrl);
        this.emit('status', this.status);
      }

      if (connection === 'open') {
        this.status = 'online';
        this.lastQrDataUrl = null;
        this.loggedOut = false;
        this.emit('status', this.status);
        console.log('[whatsapp] conectado com sucesso');
      }

      if (connection === 'close') {
        this.status = 'offline';
        this.emit('status', this.status);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const sessionLabel = path.basename(this.authFolder);
        const reason = DisconnectReason[statusCode] || 'desconhecido';

        console.warn(
          `[whatsapp:${sessionLabel}] conexão encerrada. statusCode=${statusCode} (${reason}) loggedOut=${loggedOut}`
        );

        if (!loggedOut) {
          // queda de conexão (rede, etc) -> tenta reconectar usando a sessão salva
          setTimeout(() => this.start(), 3000);
        } else {
          // usuário deslogou pelo celular -> as credenciais salvas não servem mais
          // pra reconectar (o WhatsApp já encerrou essa sessão do lado dele).
          // Fica marcado aqui; requestFreshQr() é quem de fato gera um QR novo,
          // chamado a cada acesso à sessão (ver SessionManager.get()).
          this.loggedOut = true;
          console.warn('[whatsapp] sessão encerrada pelo usuário. Aguardando novo login via /qr.');
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const m of messages) {
        const payload = await this._processIncomingMessage(m);
        if (payload) this.emit('message', payload);
      }
    });

    // Histórico de conversas que o próprio WhatsApp manda pro dispositivo —
    // Baileys já pede isso em toda conexão (syncFullHistory: true é o
    // default, nunca sobrescrito aqui) e entrega tudo já decodificado neste
    // evento, mas até agora nada escutava e o histórico era descartado.
    // Reusa o mesmo `_processIncomingMessage` do caminho de mensagem nova
    // (mesmos filtros de status/grupo/newsletter/reação, mesma resolução de
    // telefone) — o dedupe por (conversation_id, wa_message_id) em
    // store.addMessage cobre sozinho o caso de a mesma mensagem chegar de
    // novo depois por messages.upsert.
    this.sock.ev.on('messaging-history.set', async ({ messages, syncType, isLatest }) => {
      if (!messages?.length) return;

      let saved = 0;
      for (const m of messages) {
        const payload = await this._processIncomingMessage(m, { isHistory: true });
        if (payload) {
          this.emit('message', payload);
          saved++;
        }
      }
      console.log(
        `[whatsapp] histórico recebido: ${saved}/${messages.length} mensagens processadas (syncType=${syncType}, isLatest=${isLatest})`
      );
    });

    // Confirmações de entrega/leitura de mensagens que NÓS enviamos (é isso
    // que vira o "✓✓ azul" na tela — ver tickIcon no frontend).
    //
    // Diferente do messages.upsert (onde o Baileys já decodifica e preenche
    // participantAlt/remoteJidAlt com o telefone real), este evento nasce do
    // recibo de entrega/leitura cru (handleReceipt, dentro do Baileys) e NUNCA
    // populam esses campos alt — só key.remoteJid, que pro sistema novo de LID
    // do WhatsApp pode vir como "<id>@lid" (um id interno, não o telefone).
    // Sem resolver isso, o telefone batia errado com o da conversa no banco
    // (updateMessageStatus não achava a linha) e o broadcast ia pro assunto
    // errado — o "✓✓ visualizado" nunca chegava na tela. Ver _resolveLidPhone.
    this.sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        const status = this._mapStatus(u.update?.status);
        if (!status || !u.key?.id) continue;
        const phoneSource =
          u.key.participantAlt || u.key.remoteJidAlt || u.key.participant || u.key.remoteJid;
        const phone = await this._resolveLidPhone(phoneSource);
        this.emit('messageStatus', { phone, messageId: u.key.id, status });
      }
    });

    // "Digitando…"/"Gravando áudio…" do CONTATO (não da empresa) — só chega
    // pra quem o WhatsApp já mandou `presenceSubscribe` (ver subscribePresence,
    // chamado ao abrir uma conversa) e mesmo assim depende da privacidade de
    // cada contato: sem permissão, esse evento simplesmente nunca chega, sem
    // erro nenhum (best-effort, igual foto de perfil/grupos em comum).
    this.sock.ev.on('presence.update', ({ id, presences }) => {
      if (!id || id.endsWith('@g.us') || id.endsWith('@newsletter') || id.endsWith('@broadcast')) return;
      const info = presences?.[id] || Object.values(presences || {})[0];
      if (!info?.lastKnownPresence) return;
      this.emit('presence', { phone: this._jidToPhone(id), state: info.lastKnownPresence });
    });

    // Acumula contatos "vistos" pra estimativa de contagem no card da
    // instância (ver getContactCount) — Baileys só entrega incrementos
    // (upsert no sync inicial, update depois), nunca um total pronto.
    const trackContacts = (list) => {
      for (const c of list || []) {
        if (c?.id) this.contactIds.add(c.id);
      }
    };
    this.sock.ev.on('contacts.upsert', trackContacts);
    this.sock.ev.on('contacts.update', trackContacts);
  }

  // proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2 (enviado),
  // DELIVERY_ACK=3 (entregue), READ=4, PLAYED=5 (áudio/vídeo reproduzido).
  _mapStatus(code) {
    if (code == null) return null;
    if (code >= 4) return 'read';
    if (code === 3) return 'delivered';
    if (code === 2) return 'sent';
    return null;
  }

  /**
   * Chamado a cada acesso à sessão (ver SessionManager.get()). Se a sessão não
   * estiver deslogada, não faz nada. Se estiver, apaga as credenciais salvas
   * (inválidas — o WhatsApp já encerrou essa sessão do lado dele; tentar
   * reconectar com elas só falha de novo) e reinicia do zero, o que gera um QR
   * Code novo para o usuário escanear.
   */
  async requestFreshQr() {
    if (!this.loggedOut) return;
    this.loggedOut = false;
    if (fs.existsSync(this.authFolder)) {
      fs.rmSync(this.authFolder, { recursive: true, force: true });
    }
    await this.start();
  }

  /**
   * Desconecta esse WhatsApp de vez — usado ao remover uma instância. Tenta
   * deslogar do lado do WhatsApp (some da lista "Aparelhos conectados" no
   * celular) e sempre apaga as credenciais salvas, mesmo se o logout falhar
   * (ex: já estava offline).
   */
  async disconnect() {
    try {
      await this.sock?.logout();
    } catch (err) {
      console.error('[whatsapp] falha ao deslogar (limpando mesmo assim):', err.message);
    }
    this.status = 'offline';
    this.sock = null;
    if (fs.existsSync(this.authFolder)) {
      fs.rmSync(this.authFolder, { recursive: true, force: true });
    }
  }

  /**
   * `replyTo` (opcional) — `{ id, fromMe, text, type }` da mensagem sendo
   * citada (ver store.getMessageForReply). Reconstruímos só o suficiente pro
   * Baileys montar o "balão citado": não guardamos a mensagem original do
   * WhatsApp (protobuf completo), só os campos que já persistimos mesmo.
   */
  async sendMessage(phone, text, replyTo) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jid = this._phoneToJid(phone);
    const options = replyTo ? { quoted: this._buildQuoted(jid, replyTo) } : undefined;
    const result = await this.sock.sendMessage(jid, { text }, options);
    return {
      id: result.key.id,
      text,
      direction: 'out',
      status: 'sent',
      createdAt: new Date().toISOString(),
    };
  }

  _buildQuoted(jid, replyTo) {
    return {
      key: { remoteJid: jid, id: replyTo.id, fromMe: !!replyTo.fromMe },
      message: { conversation: replyTo.text || `[${replyTo.type || 'mensagem'}]` },
    };
  }

  /**
   * Reage (ou remove a reação, com `emoji` vazio/null) a uma mensagem já
   * existente na conversa. `fromMe` precisa indicar quem enviou a mensagem
   * ORIGINAL (não quem está reagindo agora) — é assim que o Baileys monta a
   * `key` de referência.
   */
  async sendReaction(phone, messageId, emoji, fromMe) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jid = this._phoneToJid(phone);
    await this.sock.sendMessage(jid, {
      react: { text: emoji || '', key: { remoteJid: jid, id: messageId, fromMe: !!fromMe } },
    });
  }

  /**
   * Avisa o contato que a empresa está "digitando…" (`state: 'composing'`),
   * "gravando áudio…" (`'recording'`) ou parou (`'paused'`) — o mesmo
   * indicador que aparece quando uma pessoa de verdade está escrevendo no
   * WhatsApp dela. Puramente ao vivo (não fica salvo em lugar nenhum); se a
   * sessão não estiver online, simplesmente não faz nada (não é um erro
   * grave o suficiente pra travar a digitação de quem está atendendo).
   */
  async sendPresence(phone, state) {
    if (this.status !== 'online' || !this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(state, this._phoneToJid(phone));
    } catch (err) {
      console.error('[whatsapp] falha ao enviar presença:', err.message);
    }
  }

  /**
   * Pede pro WhatsApp avisar (evento 'presence.update' do Baileys, repassado
   * como 'presence' por esta classe) quando esse contato começar a digitar
   * ou gravar áudio — sem isso, a sessão nunca recebe presença de ninguém.
   * Best-effort: o contato pode ter essa informação bloqueada por
   * privacidade, e nesse caso o pedido não dá erro nenhum — só nunca chega
   * evento nenhum depois.
   */
  async subscribePresence(phone) {
    if (this.status !== 'online' || !this.sock) return;
    try {
      await this.sock.presenceSubscribe(this._phoneToJid(phone));
    } catch (err) {
      console.error('[whatsapp] falha ao inscrever presença:', err.message);
    }
  }

  /**
   * Envia imagem, áudio, vídeo ou documento. `type` é 'image' | 'audio' |
   * 'video' | 'document'; `buffer` são os bytes do arquivo; `mimetype` vem
   * do arquivo original (ex: 'image/jpeg', 'audio/mpeg', 'video/mp4',
   * 'application/pdf'). Áudio vai como arquivo normal (não como nota de
   * voz/PTT). `fileName` só se aplica a 'document' (PDF, PPT, DOCX etc. —
   * anexo genérico que o WhatsApp não sabe renderizar como mídia embutida,
   * então mostra um cartão com nome + ícone do arquivo).
   *
   * Devolve também `buffer`/`mimetype` (que podem ter sido convertidos, ver
   * áudio abaixo) para quem chamou salvar exatamente os bytes que foram
   * realmente enviados.
   */
  async sendMedia(phone, { type, buffer, mimetype, caption, fileName, replyTo }) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }

    let outBuffer = buffer;
    let outMimetype = mimetype;

    if (type === 'audio') {
      // O WhatsApp só entrega/reproduz áudio em OGG/Opus (mesmo formato das
      // notas de voz nativas). Áudio gravado no navegador (webm/opus, via
      // MediaRecorder) ou em outros formatos é aceito no upload mas não chega
      // a aparecer/tocar no destinatário sem essa conversão.
      outBuffer = await convertToOggOpus(buffer);
      outMimetype = 'audio/ogg; codecs=opus';
    }

    const jid = this._phoneToJid(phone);
    const content =
      type === 'image'
        ? { image: outBuffer, mimetype: outMimetype, caption: caption || undefined }
        : type === 'video'
        ? { video: outBuffer, mimetype: outMimetype, caption: caption || undefined }
        : type === 'document'
        ? { document: outBuffer, mimetype: outMimetype, fileName: fileName || 'arquivo', caption: caption || undefined }
        : { audio: outBuffer, mimetype: outMimetype, ptt: false };
    const options = replyTo ? { quoted: this._buildQuoted(jid, replyTo) } : undefined;
    const result = await this.sock.sendMessage(jid, content, options);
    return {
      id: result.key.id,
      direction: 'out',
      status: 'sent',
      createdAt: new Date().toISOString(),
      buffer: outBuffer,
      mimetype: outMimetype,
    };
  }

  /**
   * Cria um grupo de WhatsApp de verdade (não é a "lista" de contatos da
   * Campanha — é um grupo do WhatsApp mesmo, com JID "xxxxx@g.us"). Depois de
   * criado, mandar mensagem pra esse JID (via sendMessage/sendMedia, usando o
   * id do grupo no lugar do telefone) entrega UMA mensagem que o próprio
   * WhatsApp distribui a todos os participantes.
   */
  async createGroup(name, phones) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jids = phones.map((p) => this._phoneToJid(p));
    const metadata = await this.sock.groupCreate(name, jids);
    return {
      id: metadata.id,
      name: metadata.subject || name,
      participantCount: metadata.participants?.length ?? jids.length,
    };
  }

  /**
   * Telefones dos participantes de um grupo (usado pra achar "grupos em
   * comum" com um contato, no painel de detalhes do Chat). Mesma questão de
   * LID já conhecida deste projeto (ver diagnóstico do bug de recebimento no
   * HANDOFF) — aqui o Baileys já resolve isso sozinho: cada participante
   * (`GroupParticipant extends Contact`) tem `id` (formato preferido, pode
   * ser `@lid`) e opcionalmente `phoneNumber` (formato `@s.whatsapp.net`,
   * com o telefone de verdade) — igual ao par `participant`/`participantAlt`
   * já usado pra mensagens. Sem `phoneNumber` (participante só com LID e sem
   * essa info disponível), esse participante simplesmente não aparece na
   * lista devolvida — best-effort, não uma garantia de achar todo mundo.
   */
  async getGroupParticipantPhones(groupId) {
    if (this.status !== 'online' || !this.sock) return [];
    try {
      const metadata = await this.sock.groupMetadata(groupId);
      return (metadata.participants || [])
        .map((p) => this._jidToPhone(p.phoneNumber || p.id))
        .filter((phone) => phone);
    } catch {
      return [];
    }
  }

  /**
   * URL da foto de perfil do contato (ou grupo). Devolve null se a sessão não
   * estiver online, o contato não existir, ou a privacidade dele bloquear a
   * própria foto pra nós — tudo tratado como "sem foto", não como erro.
   */
  async getProfilePicture(phone) {
    if (this.status !== 'online' || !this.sock) return null;
    try {
      const jid = this._phoneToJid(phone);
      return await this.sock.profilePictureUrl(jid, 'image');
    } catch {
      return null;
    }
  }

  // ----- helpers de formato -----

  _phoneToJid(phone) {
    const raw = String(phone);
    if (raw.includes('@')) return raw; // já é um JID pronto (grupo "@g.us" ou usuário "@s.whatsapp.net")
    const digits = raw.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  // O JID pode vir com um sufixo de dispositivo ("<telefone>:0@...", "...:12@...")
  // — sem remover isso, o telefone salvo não batia com o da conversa no banco
  // (ex: "5521965628397:0" ≠ "5521965628397"), e updateMessageStatus nunca
  // encontrava a linha pra atualizar. Confirmado no log: era exatamente essa
  // a causa do "✓✓ visualizado" nunca aparecer.
  _jidToPhone(jid) {
    return (jid || '').split('@')[0].split(':')[0];
  }

  // Resolve um JID "<id>@lid" (sistema novo de identificador do WhatsApp,
  // usado quando não há participantAlt/remoteJidAlt disponível — ver
  // messages.update acima) pro telefone de verdade, via o mapeamento
  // LID<->PN que o próprio Baileys mantém internamente. Best-effort: se a
  // sessão não tiver esse contato mapeado ainda, cai de volta pro id cru
  // (mesmo comportamento de antes) em vez de travar o processamento.
  async _resolveLidPhone(jid) {
    if (!jid || !jid.endsWith('@lid')) return this._jidToPhone(jid);
    try {
      const pn = await this.sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) return this._jidToPhone(pn);
    } catch (err) {
      console.error('[whatsapp] falha ao resolver LID->telefone:', err.message);
    }
    return this._jidToPhone(jid);
  }

  // Normaliza UMA mensagem crua do Baileys pro formato que o resto da
  // aplicação consome (mesmo payload de `this.emit('message', ...)`) —
  // usado tanto por `messages.upsert` (mensagem em tempo real) quanto por
  // `messaging-history.set` (histórico). Devolve `null` quando a mensagem
  // deve ser descartada (status, grupo, newsletter, reação, sem conteúdo).
  //
  // `isHistory: true` muda só o tratamento de falha ao baixar mídia: mensagem
  // nova sem mídia seria uma notificação incompleta (descarta, como sempre
  // foi), mas mensagem antiga sem mídia (link do CDN do WhatsApp expirado,
  // comum em histórico) ainda tem valor — mantém o texto/legenda em vez de
  // jogar a mensagem toda fora.
  async _processIncomingMessage(m, { isHistory = false } = {}) {
    if (!m.message) return null;

    // Status/Stories do WhatsApp (remoteJid "status@broadcast") — quando
    // o número conectado consegue ver o Status de um contato, o Baileys
    // entrega isso aqui igual a uma mensagem normal, com `participant`
    // identificando quem postou. Sem esse descarte, o Status virava uma
    // "mensagem" de verdade salva na conversa 1:1 daquele contato (uma
    // foto/vídeo que a pessoa nunca mandou pra ninguém, só postou no
    // Status dela). Descarta e segue, sem gravar nada.
    if (isJidBroadcast(m.key.remoteJid)) return null;

    // Mensagem de GRUPO (remoteJid termina em "@g.us") — decisão do
    // usuário depois de ver que, mesmo isolando numa conversa própria e
    // já arquivada (primeira tentativa de correção), o conteúdo do
    // grupo continuava fisicamente salvo no banco (visível direto pelo
    // Table Editor do Supabase) — o que ele não quer de jeito nenhum.
    // Descarta por completo, mesmo tratamento do Status acima. Efeito
    // colateral aceito: a funcionalidade de "criar grupo" (ver
    // createGroup()) continua criando/enviando pro grupo normalmente,
    // só que respostas de quem está no grupo não aparecem em lugar
    // nenhum do CRM — só a mensagem enviada pela própria empresa (que
    // segue outro caminho, sendMessage/sendMedia, não passa por aqui).
    if ((m.key.remoteJid || '').endsWith('@g.us')) return null;

    // Canal do WhatsApp (remoteJid termina em "@newsletter") — posts de
    // canais seguidos (ex: ESPN Brasil, Netflix Brasil) chegam pelo mesmo
    // evento messages.upsert, igual Status e grupo. Não é conversa com
    // cliente nenhum, então descarta por completo também.
    if (isJidNewsletter(m.key.remoteJid)) return null;

    // Reação (emoji) a uma mensagem existente — não é uma mensagem nova,
    // é um "ponteiro" pra mensagem original (reactionMessage.key.id).
    // `text` vazio significa que a reação foi removida.
    if (m.message.reactionMessage) {
      const r = m.message.reactionMessage;
      if (!r.key?.id) return null;
      const phoneSource = m.key.participantAlt || m.key.remoteJidAlt || m.key.participant || m.key.remoteJid;
      this.emit('reaction', {
        phone: this._jidToPhone(phoneSource),
        targetId: r.key.id,
        emoji: r.text || null,
        direction: m.key.fromMe ? 'out' : 'in',
      });
      return null;
    }

    // Não filtramos fromMe aqui: mensagens enviadas pelo próprio usuário direto
    // do celular (fora do widget) também chegam como fromMe:true, e precisam
    // ser salvas. As que já foram enviadas via sendMessage()/sendMedia() também
    // passam por aqui (o WhatsApp ecoa a própria mensagem enviada) — o dedupe
    // por id em store.addMessage evita salvar/mostrar elas duas vezes.

    // O WhatsApp novo entrega o remetente/destinatário como "<id>@lid" (sistema LID).
    // Nesta versão do Baileys, o telefone real vem em key.participantAlt
    // (mensagem de grupo) ou key.remoteJidAlt (conversa direta) — os campos
    // key.senderPn/participantPn documentados não existem nesta versão.
    // Mensagem de grupo já foi descartada acima, então participant* aqui
    // só apareceria num caso estranho (não deveria acontecer na prática).
    const phoneSource = m.key.participantAlt || m.key.remoteJidAlt || m.key.participant || m.key.remoteJid;
    const phone = this._jidToPhone(phoneSource);

    const media = this._extractMediaInfo(m.message);
    const text = media ? media.caption : this._extractText(m.message);
    let mediaUrl = null;
    let mimetype = null;

    if (media) {
      try {
        const buffer = await downloadMediaMessage(m, 'buffer', {});
        mediaUrl = await saveMedia(m.key.id, buffer, media.mimetype);
        mimetype = media.mimetype;
      } catch (err) {
        if (!isHistory) {
          console.error('[whatsapp] falha ao baixar mídia recebida:', err.message);
          return null;
        }
        console.warn(
          '[whatsapp] mídia histórica indisponível (link do WhatsApp provavelmente expirado), salvando só o texto/legenda:',
          err.message
        );
      }
    }

    if (!mediaUrl && !text) return null;

    return {
      phone,
      // Nome que o próprio contato definiu no WhatsApp dele — só vem em
      // mensagens recebidas (m.key.fromMe === false); usado pra já
      // preencher o nome do contato na interface sem cadastro manual.
      pushName: m.key.fromMe ? null : m.pushName || null,
      message: {
        id: m.key.id,
        type: mediaUrl ? media.type : 'text',
        text,
        mediaUrl,
        mimetype: mediaUrl ? mimetype : null,
        direction: m.key.fromMe ? 'out' : 'in',
        status: m.key.fromMe ? 'sent' : 'delivered',
        createdAt: new Date((m.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
        replyToId: this._extractReplyToId(m.message),
        fileName: media?.fileName || null,
      },
    };
  }

  _extractText(message) {
    return message.conversation || message.extendedTextMessage?.text || null;
  }

  // Id da mensagem original quando esta é uma resposta ("reply") a outra —
  // o WhatsApp guarda isso em `contextInfo.stanzaId`, dentro do tipo real da
  // mensagem (nunca em `conversation`: uma resposta de texto sempre chega
  // como extendedTextMessage, mesmo sem nenhuma formatação especial).
  _extractReplyToId(message) {
    const ctx =
      message.extendedTextMessage?.contextInfo ||
      message.imageMessage?.contextInfo ||
      message.videoMessage?.contextInfo ||
      message.audioMessage?.contextInfo;
    return ctx?.stanzaId || null;
  }

  // Mensagem de imagem, áudio ou vídeo -> { type, mimetype, caption } | null.
  // (Documento ainda não é tratado.)
  _extractMediaInfo(message) {
    if (message.imageMessage) {
      return {
        type: 'image',
        mimetype: message.imageMessage.mimetype,
        caption: message.imageMessage.caption || null,
      };
    }
    if (message.videoMessage) {
      return {
        type: 'video',
        mimetype: message.videoMessage.mimetype,
        caption: message.videoMessage.caption || null,
      };
    }
    if (message.audioMessage) {
      return {
        type: 'audio',
        mimetype: message.audioMessage.mimetype,
        caption: null,
      };
    }
    if (message.documentMessage) {
      return {
        type: 'document',
        mimetype: message.documentMessage.mimetype,
        caption: message.documentMessage.caption || null,
        fileName: message.documentMessage.fileName || null,
      };
    }
    return null;
  }
}

module.exports = { WhatsAppGateway };
