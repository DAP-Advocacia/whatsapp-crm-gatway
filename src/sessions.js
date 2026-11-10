const fs = require('fs');
const path = require('path');
const { WhatsAppGateway } = require('./whatsapp');
const { refreshOwnNumber } = require('./ownNumbers');
const { flushAuthWrites } = require('./authState');

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
  constructor({ baseFolder, onStatus, onMessage, onReaction, onMessageChange, onMessageStatus, onPresence, onContact, onQr, onCall, isCardGroup, staggerMs, pairingGapMs, shardFilter, loginGate }) {
    this.baseFolder = baseFolder;
    this.onStatus = onStatus; // (sessionId, status) => void
    this.onQr = onQr; // (sessionId) => void — só o worker usa (repassa o QR novo ao processo principal)
    this.onCall = onCall; // (sessionId, { phone, callId, status, isVideo, offline, createdAt }) => void
    // Opções do modo com workers (ver src/sessionWorker.js): cada worker sobe só
    // as sessões do seu pedaço (shardFilter) e espaça os logins N vezes mais,
    // pra o ritmo TOTAL de logins no IP continuar o mesmo de um processo só.
    this.staggerMs = staggerMs;
    this.shardFilter = shardFilter;
    // Trava global de logins (2026-11-09): () => Promise que resolve quando o
    // processo principal libera UM login. O intervalo de 5 s passa a ser contado
    // entre TODOS os workers juntos, e não mais por worker (N vezes mais lento).
    // Sem ela (null), vale o espaçamento local de minPairingGapMs.
    this.loginGate = loginGate || null;
    this.onMessage = onMessage; // (sessionId, phone, message, pushName, isHistory, senderPhone, senderName) => void
    this.onReaction = onReaction; // (sessionId, phone, targetId, emoji, direction) => void
    this.onMessageChange = onMessageChange; // (sessionId, { phone, messageId, kind: 'edit'|'revoke', text? }) => void
    this.onMessageStatus = onMessageStatus; // (sessionId, phone, messageId, status) => void
    this.onPresence = onPresence; // (sessionId, phone, state) => void
    // Nome de contato vindo direto da agenda do WhatsApp (contacts.upsert/
    // update ao vivo, ou a lista `contacts` dentro do backfill de
    // histórico) — diferente de onMessage/pushName, que só vem em mensagem
    // NOVA recebida (nunca em histórico). Ver WhatsAppGateway._extractContactInfo.
    this.onContact = onContact; // (sessionId, phone, name) => void
    // Repassado direto pro construtor de cada WhatsAppGateway (ver
    // whatsapp.js) — decide se uma mensagem de grupo é "de card" (feature
    // de Negócio) ou deve continuar sendo descartada, comportamento padrão
    // de sempre. Opcional — WhatsAppGateway já tem um default seguro.
    this.isCardGroup = isCardGroup;
    this.sessions = new Map(); // sessionId -> WhatsAppGateway

    // Fila de pareamento (2026-10-05) — mesma motivação do STAGGER_MS em
    // startAllExisting() (incidente de 31/07/2026: várias conexões abrindo
    // no mesmo instante parecem login em massa pro WhatsApp, que reage
    // deslogando sessões), mas cobrindo o OUTRO caminho que dispara
    // start(): alguém abrindo a tela de Conexões pela primeira vez (GET
    // /qr -> este get()). Sem fila aqui, uma campanha avisando "conecte
    // seu WhatsApp" fazia dezenas de pessoas chegarem nesta rota ao mesmo
    // tempo, cada uma disparando um handshake Noise + sync de histórico
    // simultâneo — saturava o único core do event loop e deixava até telas
    // sem relação nenhuma (Chat de quem já estava conectado) lentas.
    //
    // `get()` continua SÍNCRONO e retornando o gateway na hora — o
    // polling do frontend (GET /qr a cada 2.5s) depende de já existir um
    // objeto com getStatus()/getLastQr() desde a primeira chamada. O que
    // fica na fila é só a CHAMADA de start() (o trabalho pesado de
    // verdade); enquanto espera vaga, gateway.getStatus() devolve
    // 'queued' (ver WhatsAppGateway, novo status só pra isso).
    this.pairingQueue = [];
    this.activePairings = 0;
    this.maxConcurrentPairings = Number(process.env.MAX_CONCURRENT_PAIRINGS || 4);
    // Espaçamento MÍNIMO entre dois start() (2026-10-30). Com o boot
    // preguiçoso (server.js, SESSION_BOOT_MODE) as sessões sobem quando o dono
    // abre o app, então o limite de concorrência acima sozinho não segura uma
    // rajada (start() devolve assim que o socket é criado, a fila esvaziava em
    // segundos). Sessão que chega com a fila ociosa começa NA HORA (ninguém
    // espera); só a 2ª, 3ª... de uma rajada esperam este intervalo. Padrão 5s
    // — o incidente de 31/07 e o teste de 03/08 (5 de 11 caíram com 4s, ver
    // ROADMAP) mostram que abrir muitos logins juntos derruba sessões.
    this.minPairingGapMs = Number(pairingGapMs ?? process.env.PAIRING_MIN_GAP_MS ?? 5000);
    this.lastPairingStartAt = 0;
    this.pairingTimer = null;
    this.stopping = false; // true depois de shutdown(): não inicia mais nenhuma sessão
  }

  _runPairingQueue() {
    if (this.stopping || this.pairingTimer || !this.pairingQueue.length || this.activePairings >= this.maxConcurrentPairings) return;
    const startNext = () => {
      this.pairingTimer = null;
      if (this.stopping || !this.pairingQueue.length || this.activePairings >= this.maxConcurrentPairings) return;
      const gateway = this.pairingQueue.shift();
      // Removida, ou já iniciada por outro caminho (QR, "tentar reconectar") enquanto esperava na fila:
      // iniciar de novo abriria um 2º socket da mesma sessão.
      if (gateway.destroyed || gateway.status !== 'queued') {
        this._runPairingQueue();
        return;
      }
      this.lastPairingStartAt = Date.now();
      this.activePairings++;
      gateway.status = 'connecting'; // sai de 'queued' assim que o start() real começa
      gateway
        .start()
        .catch((err) => console.error(`[whatsapp:${gateway.sessionId}] falha ao iniciar sessão:`, err.message))
        .finally(() => {
          this.activePairings--;
          this._runPairingQueue();
        });
      this._runPairingQueue(); // agenda o próximo (respeitando o espaçamento)
    };
    if (this.loginGate) {
      // Quem dita o ritmo é o processo principal (um login por vez, no máximo a cada
      // PAIRING_MIN_GAP_MS somando todos os workers). `true` só marca "pedido em andamento".
      this.pairingTimer = true;
      this.loginGate().then(startNext, startNext);
      return;
    }
    const wait = Math.max(0, this.lastPairingStartAt + this.minPairingGapMs - Date.now());
    this.pairingTimer = setTimeout(startNext, wait);
  }

  // Sessão que NUNCA foi pareada (sem creds.me) só gera um QR — não é um login de
  // conta existente, então não precisa do espaçamento que protege contra login em
  // massa (esse espaçamento é pras sessões já pareadas reconectando). Antes, tudo
  // entrava na MESMA fila: com 4 workers o intervalo é de 20 s por sessão, e
  // dezenas de telas de QR abertas (cada consulta recoloca a sessão ociosa na
  // fila) formavam uma fila de ~10 min — quem criava uma conexão nova ficava só
  // com a barra de progresso, sem QR (reportado 2026-11-04).
  _isUnpaired(gateway) {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(gateway.authFolder, 'creds.json'), 'utf8'));
      return !creds.me;
    } catch {
      return true; // sem creds.json (ou ilegível): nunca pareada
    }
  }

  _enqueuePairing(gateway) {
    if (this.stopping) return;
    if (this._isUnpaired(gateway)) {
      gateway.status = 'connecting';
      gateway.start().catch((err) => console.error(`[whatsapp:${gateway.sessionId}] falha ao iniciar sessão:`, err.message));
      return;
    }
    gateway.status = 'queued';
    this.pairingQueue.push(gateway);
    this._runPairingQueue();
  }

  /**
   * Devolve (criando e iniciando se necessário) o gateway daquele usuário.
   * Iniciar gera um QR novo caso ainda não exista sessão pareada na pasta.
   */
  get(sessionId, { boot = false, wantQr = false } = {}) {
    const id = sanitize(sessionId);
    if (!id) throw new Error('sessão inválida');
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      // Prioridade (2026-11-04): sessão que entrou na fila pelo boot automático e agora
      // um usuário pediu (abriu o app) passa pra FRENTE da fila — quem está esperando
      // com a tela aberta não fica atrás de sessões de gente que nem está online. O
      // espaçamento entre logins continua valendo.
      if (!boot && existing._bootQueued && existing.getStatus() === 'queued') {
        const i = this.pairingQueue.indexOf(existing);
        if (i > 0) {
          this.pairingQueue.splice(i, 1);
          this.pairingQueue.unshift(existing);
        }
        existing._bootQueued = false;
      }
      // Sessão deslogada pelo celular ou nunca pareada com o QR expirado: só
      // gera QR novo quando alguém PEDE o QR (GET /qr, janela de QR aberta).
      // Até 2026-11-05 qualquer acesso (status, foto, histórico, WebSocket do
      // Chat) reiniciava o pareamento: 564 QRs/h em produção, gerados pra
      // ninguém, no mesmo worker que segura as sessões conectadas.
      if (wantQr) {
        existing.requestFreshQr().catch((err) =>
          console.error(`[whatsapp:${id}] falha ao reiniciar sessão deslogada:`, err.message)
        );
      }
      if (wantQr && existing.idleUnpaired && existing.getStatus() === 'offline' && !existing.starting) {
        existing.idleUnpaired = false;
        this._enqueuePairing(existing);
      }
      return existing;
    }

    const gateway = new WhatsAppGateway({
      authFolder: path.join(this.baseFolder, id),
      sessionId: id,
      isCardGroup: this.isCardGroup,
      scheduleStart: (gw) => this._enqueuePairing(gw), // reconexão automática passa pela fila/trava de logins
    });
    gateway.on('status', (status) => this.onStatus(id, status));
    gateway.on('message', ({ phone, message, pushName, isHistory, senderPhone, senderName }) =>
      this.onMessage(id, phone, message, pushName, isHistory, senderPhone, senderName)
    );
    gateway.on('reaction', ({ phone, targetId, emoji, direction }) => this.onReaction?.(id, phone, targetId, emoji, direction));
    gateway.on('messageChange', (change) => this.onMessageChange?.(id, change));
    gateway.on('messageStatus', ({ phone, messageId, status }) => this.onMessageStatus?.(id, phone, messageId, status));
    gateway.on('presence', ({ phone, state }) => this.onPresence?.(id, phone, state));
    gateway.on('contact', ({ phone, name }) => this.onContact?.(id, phone, name));
    gateway.on('qr', () => this.onQr?.(id));
    gateway.on('call', (info) => this.onCall?.(id, info));
    gateway._bootQueued = boot; // veio do boot automático: um acesso de usuário depois dá prioridade (ver acima)
    this._enqueuePairing(gateway);

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
      refreshOwnNumber(id); // número some do cache (a pasta de credenciais já foi apagada no disconnect)
      return;
    }
    const folder = path.join(this.baseFolder, id);
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    refreshOwnNumber(id);
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
    const STAGGER_MS = Number(this.staggerMs || process.env.SESSION_STAGGER_MS || 15000);
    const entries = fs.readdirSync(this.baseFolder, { withFileTypes: true });
    // `creds.registered` (Baileys, ver initAuthCreds) só vira true DEPOIS do
    // QR ser escaneado com sucesso — antes disso, creds.json já existe (o
    // Baileys grava as chaves de criptografia assim que a sessão é aberta,
    // mesmo sem ninguém ter escaneado nada) mas não representa uma sessão
    // de verdade, só um QR gerado e nunca pareado. Sem este filtro, cada
    // "Conectar outro WhatsApp" abandonado no meio do caminho virava uma
    // pasta que o boot tentava reconectar pra sempre — encontrado um
    // acúmulo real de centenas dessas pastas (meses de QRs nunca
    // escaneados), sobrecarregando CPU/rede a cada boot e, no caso mais
    // grave, levando o WhatsApp a atrasar/recusar até pareamentos NOVOS
    // vindos do mesmo IP (mesmo padrão do incidente de 31/07 documentado
    // acima, só que em escala muito maior).
    let skippedUnregistered = 0;
    const pending = entries.filter((entry) => {
      if (!entry.isDirectory()) return false;
      if (this.shardFilter && !this.shardFilter(entry.name)) return false;
      const credsPath = path.join(this.baseFolder, entry.name, 'creds.json');
      if (!fs.existsSync(credsPath)) return false;
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        // 2026-11-04: no Baileys 7 `registered` nunca é gravado como true (medido em
        // produção: 0 de 573 sessões pareadas), então o filtro só por ele descartava
        // TODAS e o boot "all" retomava 0 sessões. `me` é o que identifica o pareamento.
        if (!creds.registered && !creds.me) {
          skippedUnregistered++;
          return false;
        }
        return true;
      } catch {
        // creds.json corrompido/ilegível — mesmo espírito de "não é uma
        // sessão de verdade utilizável", não tenta reconectar.
        skippedUnregistered++;
        return false;
      }
    });
    if (skippedUnregistered > 0) {
      console.log(`[sessions] ignorando ${skippedUnregistered} sessão(ões) nunca pareada(s) (QR gerado, nunca escaneado)`);
    }
    console.log(`[sessions] retomando ${pending.length} sessão(ões) salva(s), escalonado a cada ${STAGGER_MS}ms`);
    for (const entry of pending) {
      if (this.stopping) return;
      console.log(`[sessions] retomando sessão salva: ${entry.name}`);
      this.get(entry.name, { boot: true });
      if (entry !== pending[pending.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
      }
    }
  }

  /**
   * Desligamento limpo (SIGTERM do deploy/Swarm): para de iniciar sessões, fecha os
   * sockets SEM deslogar (as sessões continuam válidas e voltam no próximo boot) e
   * espera as gravações de credenciais em andamento terminarem — assim o processo
   * não é morto com um arquivo pela metade.
   */
  async shutdown(flushMs = 5000) {
    this.stopping = true;
    if (this.pairingTimer) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = null;
    }
    this.pairingQueue.length = 0;
    for (const gateway of this.sessions.values()) {
      try { gateway.shutdown(); } catch (err) { console.error(`[whatsapp:${gateway.sessionId}] erro ao desligar:`, err.message); }
    }
    await flushAuthWrites(flushMs);
  }

  /**
   * Lista as sessões que JÁ estão em memória (conectadas ou não), sem criar
   * nenhuma sessão nova — diferente de `get()`, que cria+inicia se ainda não
   * existir. Usado por diagnósticos que precisam de um socket Baileys
   * REALMENTE conectado (ex: resolver LID->telefone via
   * signalRepository.lidMapping) sem o risco de iniciar uma conexão nova só
   * de tentar ler o estado (HANDOFF Parte CP — investigação das conversas
   * antigas com telefone LID cru).
   */
  listActive() {
    return Array.from(this.sessions.entries()).map(([id, gateway]) => ({
      sessionId: id,
      status: gateway.getStatus(),
      hasSock: !!gateway.sock,
    }));
  }

  /**
   * Devolve o gateway já em memória (SEM criar/iniciar nada) — companheiro
   * de `listActive()` pra quando o diagnóstico já confirmou que a sessão
   * está online e precisa do objeto de verdade (ex: chamar
   * `resolveLidToPhone`). `undefined` se não estiver em memória.
   */
  getActiveGateway(sessionId) {
    return this.sessions.get(sanitize(sessionId));
  }
}

module.exports = { SessionManager, sanitize };
