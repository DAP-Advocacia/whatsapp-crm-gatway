const fs = require('fs');
const path = require('path');

const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_session';

// Telefone (só dígitos) do próprio WhatsApp de cada sessão, lido direto das
// credenciais salvas em disco (funciona mesmo se a sessão não estiver online
// agora). Usado para distinguir uma conversa "interna" (o contato do outro
// lado é o WhatsApp de OUTRO usuário do Bitrix — ex: teste entre colegas) de
// uma "externa" (cliente/lead de fora) — ver src/metrics.js e a tag
// automática Interno/Externo em src/store.js (listConversations).
//
// CACHE (2026-10-30): antes, TODA chamada fazia readdirSync + readFileSync +
// JSON.parse de TODOS os creds.json do disco, de forma síncrona — e é chamada
// a cada listagem de conversas do Chat (store.listConversations, inclusive a
// cada busca digitada), a cada GET /instances e nas métricas. Com ~700
// sessões isso bloqueava o event loop por centenas de ms POR CHAMADA (medido:
// ~350ms/700 sessões, ~750ms/1500), e com o escritório inteiro usando o Chat
// virou o gargalo de CPU de um único núcleo do processo Node.
//
// O número de uma sessão só muda quando ela pareia (ou é removida), então:
//  - 1ª chamada: leitura completa síncrona (precisa de um valor pra devolver);
//  - depois: devolve o mapa em memória na hora, sem tocar no disco;
//  - refreshOwnNumber(sessionId) relê SÓ aquela pasta (chamado quando a sessão
//    fica online / é removida, ver server.js e sessions.js);
//  - rede de segurança: varredura completa ASSÍNCRONA a cada
//    FULL_REFRESH_MS (pega qualquer mudança que não passou pelos ganchos
//    acima, sem bloquear o event loop).
// A API continua síncrona e devolvendo o mesmo formato — nenhum chamador muda.
// Quem chama NÃO deve alterar o objeto devolvido (é o próprio cache).

const FULL_REFRESH_MS = 5 * 60 * 1000;

let cache = null; // { map, at }
let refreshing = null;
// Ajustes por sessão feitos ENQUANTO uma varredura completa assíncrona roda — são
// reaplicados sobre o resultado dela, senão ela (que pode ter lido a pasta
// antes do pareamento) sobrescreveria um número recém-atualizado.
let patchesDuringRefresh = null;

function phoneFromCreds(raw) {
  const creds = JSON.parse(raw);
  const meId = creds?.me?.id; // formato: "5521999999999:9@s.whatsapp.net"
  return meId ? meId.split('@')[0].split(':')[0] : null;
}

function readAllSync() {
  const bySession = {};
  if (!fs.existsSync(AUTH_FOLDER)) return bySession;

  for (const entry of fs.readdirSync(AUTH_FOLDER, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const credsPath = path.join(AUTH_FOLDER, entry.name, 'creds.json');
    try {
      const phone = phoneFromCreds(fs.readFileSync(credsPath, 'utf-8'));
      if (phone) bySession[entry.name] = phone;
    } catch {
      // sem creds.json, corrompido ou em uso no momento da leitura — ignora essa sessão
    }
  }
  return bySession;
}

async function readAllAsync() {
  const bySession = {};
  let entries;
  try {
    entries = await fs.promises.readdir(AUTH_FOLDER, { withFileTypes: true });
  } catch {
    return bySession;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const BATCH = 25; // não abrir centenas de arquivos de uma vez só
  for (let i = 0; i < dirs.length; i += BATCH) {
    await Promise.all(dirs.slice(i, i + BATCH).map(async (entry) => {
      try {
        const raw = await fs.promises.readFile(path.join(AUTH_FOLDER, entry.name, 'creds.json'), 'utf-8');
        const phone = phoneFromCreds(raw);
        if (phone) bySession[entry.name] = phone;
      } catch {
        // idem readAllSync
      }
    }));
  }
  return bySession;
}

function getOwnNumbersBySession() {
  const now = Date.now();
  if (!cache) {
    cache = { map: readAllSync(), at: now };
    return cache.map;
  }
  if (now - cache.at > FULL_REFRESH_MS && !refreshing) {
    patchesDuringRefresh = new Map();
    refreshing = readAllAsync()
      .then((map) => {
        for (const [id, phone] of patchesDuringRefresh) {
          if (phone) map[id] = phone;
          else delete map[id];
        }
        cache = { map, at: Date.now() };
      })
      .catch((err) => console.error('[ownNumbers] falha na atualização completa:', err.message))
      .finally(() => { refreshing = null; patchesDuringRefresh = null; });
  }
  return cache.map;
}

// Relê só a pasta de UMA sessão (barato: 1 arquivo). Chamado quando a sessão
// fica online (acabou de parear ou reconectou) e depois de removê-la.
function refreshOwnNumber(sessionId) {
  if (!cache || !sessionId) return; // cache ainda não existe: a 1ª leitura completa já pega tudo
  try {
    const phone = phoneFromCreds(fs.readFileSync(path.join(AUTH_FOLDER, sessionId, 'creds.json'), 'utf-8'));
    if (phone) cache.map[sessionId] = phone;
    else delete cache.map[sessionId];
    if (patchesDuringRefresh) patchesDuringRefresh.set(sessionId, phone);
  } catch {
    delete cache.map[sessionId]; // pasta/arquivo não existe mais (sessão removida) ou ilegível
    if (patchesDuringRefresh) patchesDuringRefresh.set(sessionId, null);
  }
}

module.exports = { getOwnNumbersBySession, refreshOwnNumber };
